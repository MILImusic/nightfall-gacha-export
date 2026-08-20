param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Start", "Stop")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$EtlPath,

  [Parameter(Mandatory = $true)]
  [string]$PcapPath
)

$ErrorActionPreference = "Stop"

if ($Action -eq "Start") {
  pktmon stop 2>$null | Out-Null
  pktmon filter remove 2>$null | Out-Null
  Remove-Item -LiteralPath $EtlPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PcapPath -Force -ErrorAction SilentlyContinue
  pktmon filter add NightfallGacha -p 12090 | Out-Null
  pktmon start --capture --pkt-size 0 --file-name $EtlPath | Out-Null
  exit 0
}

pktmon stop | Out-Null
pktmon etl2pcap $EtlPath --out $PcapPath | Out-Null
pktmon filter remove | Out-Null
