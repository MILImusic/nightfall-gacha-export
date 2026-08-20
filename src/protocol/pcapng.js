const BLOCK_SECTION_HEADER = 0x0a0d0d0a;
const BLOCK_INTERFACE_DESCRIPTION = 0x00000001;
const BLOCK_ENHANCED_PACKET = 0x00000006;
const LINKTYPE_ETHERNET = 1;

function ensureRange(buffer, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`${label} 超出文件范围`);
  }
}

function readBlockLength(buffer, offset, littleEndian) {
  return littleEndian
    ? buffer.readUInt32LE(offset + 4)
    : buffer.readUInt32BE(offset + 4);
}

function readUInt32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function detectSectionEndianness(buffer, offset) {
  ensureRange(buffer, offset + 8, 4, "pcapng byte-order magic");
  const magic = buffer.subarray(offset + 8, offset + 12).toString("hex");
  if (magic === "4d3c2b1a") return true;
  if (magic === "1a2b3c4d") return false;
  throw new Error("无法识别 pcapng 字节序");
}

function parsePcapNg(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("buffer 必须是 Buffer");

  const packets = [];
  let offset = 0;
  let littleEndian = true;
  let interfaces = [];

  while (offset + 12 <= buffer.length) {
    const typeLE = buffer.readUInt32LE(offset);
    const typeBE = buffer.readUInt32BE(offset);
    const isSection = typeLE === BLOCK_SECTION_HEADER || typeBE === BLOCK_SECTION_HEADER;
    if (isSection) {
      littleEndian = detectSectionEndianness(buffer, offset);
      interfaces = [];
    }

    const type = littleEndian ? typeLE : typeBE;
    const totalLength = readBlockLength(buffer, offset, littleEndian);
    if (totalLength < 12 || totalLength % 4 !== 0) {
      throw new Error(`非法 pcapng block 长度: ${totalLength}`);
    }
    ensureRange(buffer, offset, totalLength, "pcapng block");

    const trailerLength = readUInt32(buffer, offset + totalLength - 4, littleEndian);
    if (trailerLength !== totalLength) throw new Error("pcapng block 首尾长度不一致");

    if (type === BLOCK_INTERFACE_DESCRIPTION) {
      ensureRange(buffer, offset + 8, 8, "pcapng interface block");
      interfaces.push({ linkType: littleEndian
        ? buffer.readUInt16LE(offset + 8)
        : buffer.readUInt16BE(offset + 8) });
    } else if (type === BLOCK_ENHANCED_PACKET) {
      ensureRange(buffer, offset + 8, 20, "pcapng packet header");
      const interfaceId = readUInt32(buffer, offset + 8, littleEndian);
      const capturedLength = readUInt32(buffer, offset + 20, littleEndian);
      ensureRange(buffer, offset + 28, capturedLength, "pcapng packet data");
      packets.push({
        linkType: interfaces[interfaceId]?.linkType,
        data: Buffer.from(buffer.subarray(offset + 28, offset + 28 + capturedLength)),
      });
    }

    offset += totalLength;
  }

  return packets;
}

function parseIpv4Tcp(packet) {
  if (packet.linkType !== LINKTYPE_ETHERNET) return null;
  const data = packet.data;
  if (data.length < 14) return null;

  let etherType = data.readUInt16BE(12);
  let ipOffset = 14;
  if (etherType === 0x8100 && data.length >= 18) {
    etherType = data.readUInt16BE(16);
    ipOffset = 18;
  }
  if (etherType !== 0x0800 || data.length < ipOffset + 20) return null;

  const version = data[ipOffset] >> 4;
  const ipHeaderLength = (data[ipOffset] & 0x0f) * 4;
  if (version !== 4 || ipHeaderLength < 20 || data.length < ipOffset + ipHeaderLength) return null;
  if (data[ipOffset + 9] !== 6) return null;

  const totalLength = data.readUInt16BE(ipOffset + 2);
  const tcpOffset = ipOffset + ipHeaderLength;
  if (data.length < tcpOffset + 20) return null;
  const tcpHeaderLength = (data[tcpOffset + 12] >> 4) * 4;
  if (tcpHeaderLength < 20 || data.length < tcpOffset + tcpHeaderLength) return null;

  const payloadLength = Math.max(0, totalLength - ipHeaderLength - tcpHeaderLength);
  const payloadStart = tcpOffset + tcpHeaderLength;
  const payloadEnd = Math.min(data.length, payloadStart + payloadLength);

  return {
    sourceAddress: [...data.subarray(ipOffset + 12, ipOffset + 16)].join("."),
    destinationAddress: [...data.subarray(ipOffset + 16, ipOffset + 20)].join("."),
    sourcePort: data.readUInt16BE(tcpOffset),
    destinationPort: data.readUInt16BE(tcpOffset + 2),
    sequence: data.readUInt32BE(tcpOffset + 4),
    payload: Buffer.from(data.subarray(payloadStart, payloadEnd)),
  };
}

module.exports = { parsePcapNg, parseIpv4Tcp };
