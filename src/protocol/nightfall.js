const GAME_PORT = 12090;
const HISTORY_COMMAND = "000c08";
const POOL_CATALOG_COMMAND = "000c0b";

function readVarint(buffer, start = 0) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length && shift <= 63n) {
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error("非法 protobuf varint");
}

function safeNumber(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function decodeMessage(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    if (fieldNumber <= 0) throw new Error("非法 protobuf field number");

    if (wireType === 0) {
      const item = readVarint(buffer, offset);
      offset = item.offset;
      fields.push({ fieldNumber, wireType, value: safeNumber(item.value) });
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const size = Number(length.value);
      if (!Number.isSafeInteger(size) || offset + size > buffer.length) {
        throw new Error("非法 protobuf length-delimited field");
      }
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + size) });
      offset += size;
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error("截断的 protobuf fixed64");
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error("截断的 protobuf fixed32");
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`暂不支持 protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

function scalar(fields, number, fallback = 0) {
  return fields.find((field) => field.fieldNumber === number && field.wireType === 0)?.value ?? fallback;
}

function decodeHistoryRecord(buffer) {
  const fields = decodeMessage(buffer);
  const timestampMs = scalar(fields, 3);
  return {
    poolId: scalar(fields, 1),
    resultId: scalar(fields, 2),
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
  };
}

function decodeHistoryResponse(payload) {
  const fields = decodeMessage(payload);
  return {
    offset: scalar(fields, 1),
    total: scalar(fields, 2),
    records: fields
      .filter((field) => field.fieldNumber === 3 && field.wireType === 2)
      .map((field) => decodeHistoryRecord(field.value)),
  };
}

function decodeHistoryRequest(payload) {
  const fields = decodeMessage(payload);
  return { poolId: scalar(fields, 1), pageIndex: scalar(fields, 2) };
}

function decodePoolCatalogRecord(buffer) {
  const fields = decodeMessage(buffer);
  const pityBytes = fields.find((field) => field.fieldNumber === 4 && field.wireType === 2)?.value;
  const pityFields = pityBytes ? decodeMessage(pityBytes) : [];
  return {
    poolId: scalar(fields, 1),
    totalDraws: scalar(fields, 2),
    status: scalar(fields, 3),
    pityType: scalar(pityFields, 1),
    pityCount: scalar(pityFields, 2),
    relatedItemId: scalar(fields, 5),
    flag: scalar(fields, 6),
  };
}

function decodePoolCatalogResponse(payload) {
  return decodeMessage(payload)
    .filter((field) => field.fieldNumber === 1 && field.wireType === 2)
    .map((field) => decodePoolCatalogRecord(field.value))
    .filter((item) => Number(item.poolId) > 0);
}

function encodeVarint(value) {
  let current = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
}

function encodeHistoryRequest(poolId, pageIndex) {
  return Buffer.concat([
    Buffer.from([0x08]), encodeVarint(poolId),
    Buffer.from([0x10]), encodeVarint(pageIndex),
  ]);
}

function buildClientFrame(command, payload, requestId) {
  const body = Buffer.alloc(9 + payload.length);
  body.writeUInt32BE(requestId, 0);
  Buffer.from(command, "hex").copy(body, 4);
  body[7] = 0;
  body[8] = requestId & 0xff;
  payload.copy(body, 9);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function reassembleSegments(segments) {
  const ordered = [...segments].sort((a, b) => a.sequence - b.sequence);
  if (ordered.length === 0) return Buffer.alloc(0);
  const chunks = [];
  let nextSequence = ordered[0].sequence;
  for (const segment of ordered) {
    const overlap = Math.max(0, nextSequence - segment.sequence);
    if (overlap >= segment.payload.length) continue;
    if (segment.sequence > nextSequence) throw new Error("TCP 捕获存在缺口，请重新捕获");
    chunks.push(segment.payload.subarray(overlap));
    nextSequence = segment.sequence + segment.payload.length;
  }
  return Buffer.concat(chunks);
}

function splitFrames(stream) {
  const frames = [];
  let offset = 0;
  while (offset + 4 <= stream.length) {
    const bodyLength = stream.readUInt32BE(offset);
    const end = offset + 4 + bodyLength;
    if (bodyLength < 8 || end > stream.length) break;
    frames.push(stream.subarray(offset, end));
    offset = end;
  }
  return frames;
}

function collectFlowFrames(tcpPackets) {
  const flows = new Map();
  const seen = new Set();
  for (const packet of tcpPackets) {
    if (packet.payload.length === 0) continue;
    const direction = packet.sourcePort === GAME_PORT ? "server" : packet.destinationPort === GAME_PORT ? "client" : null;
    if (!direction) continue;
    const key = `${direction}:${packet.sourceAddress}:${packet.sourcePort}:${packet.destinationAddress}:${packet.destinationPort}`;
    const duplicateKey = `${key}:${packet.sequence}:${packet.payload.toString("hex")}`;
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    if (!flows.has(key)) flows.set(key, { direction, segments: [] });
    flows.get(key).segments.push(packet);
  }
  return [...flows.values()].flatMap(({ direction, segments }) => {
    try {
      return splitFrames(reassembleSegments(segments)).map((frame) => ({ direction, frame }));
    } catch {
      return [];
    }
  });
}

function extractHistoryCapture(tcpPackets) {
  const frames = collectFlowFrames(tcpPackets);
  const requests = new Map();
  for (const { direction, frame } of frames) {
    if (direction !== "client" || frame.length < 13) continue;
    if (frame.subarray(8, 11).toString("hex") !== HISTORY_COMMAND) continue;
    requests.set(frame[12], decodeHistoryRequest(frame.subarray(13)));
  }

  const pages = [];
  for (const { direction, frame } of frames) {
    if (direction !== "server" || frame.length < 13) continue;
    if (frame.subarray(4, 7).toString("hex") !== HISTORY_COMMAND) continue;
    if (frame[7] !== 0) continue;
    const requestId = frame[10];
    const response = decodeHistoryResponse(frame.subarray(12));
    pages.push({ requestId, ...(requests.get(requestId) ?? {}), ...response });
  }

  const allPages = pages.filter((page) => page.poolId === 0);
  const selected = allPages.length > 0 ? allPages : pages;
  const occurrences = new Map();
  const records = [];
  for (const page of [...selected].sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0))) {
    for (const record of page.records) {
      const signature = `${record.poolId}:${record.resultId}:${record.timestampMs}`;
      const occurrence = (occurrences.get(signature) ?? 0) + 1;
      occurrences.set(signature, occurrence);
      records.push({ ...record, key: `${signature}:${occurrence}` });
    }
  }
  records.sort((a, b) => b.timestampMs - a.timestampMs || b.resultId - a.resultId || a.key.localeCompare(b.key));
  const expectedTotal = Math.max(0, ...selected.map((page) => Number(page.total) || 0));
  return {
    expectedTotal,
    pageCount: new Set(selected.map((page) => page.pageIndex).filter(Number.isInteger)).size,
    records,
    complete: expectedTotal > 0 && records.length >= expectedTotal,
  };
}

module.exports = {
  GAME_PORT,
  HISTORY_COMMAND,
  POOL_CATALOG_COMMAND,
  collectFlowFrames,
  buildClientFrame,
  decodeHistoryRequest,
  decodeHistoryResponse,
  decodePoolCatalogResponse,
  encodeHistoryRequest,
  extractHistoryCapture,
  readVarint,
  reassembleSegments,
  splitFrames,
};
