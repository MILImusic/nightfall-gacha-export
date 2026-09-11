/*
 * Nightfall TCP redirector, derived from WinDivert's streamdump example.
 * This file is licensed under LGPL-3.0-or-later.
 */
#include <winsock2.h>
#include <windows.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "windivert.h"

#define MAXBUF WINDIVERT_MTU_MAX
#define MAX_LOCAL_ADDRS 64
#define LOCAL_ADDRS_REFRESH_MS 2000

static HANDLE divert_handle = INVALID_HANDLE_VALUE;
typedef struct
{
    UINT32 client_addr;
    UINT32 server_addr;
    BOOL valid;
} CONNECTION_MAP;
static CONNECTION_MAP connections[65536];
static volatile LONG first_intercepted = 0;
static volatile LONG proxy_confirmed = 0;
static ULONGLONG first_intercepted_at = 0;

/*
 * 本机已分配的 IPv4 地址表。
 * 用途：把游戏这条连接的原始源地址（= 它真正绑的那块网卡）当作反射目的地，
 * 而不是整台机器赌命令行传进来的那一个地址。多网卡的机器（有线 + 手机热点、
 * 有线 + WiFi）上，选错网卡的反射包会被 Windows 的强主机模型直接丢掉，
 * 代理永远等不到 SYN，5 秒后 watchdog fail-open——用户看到的就是
 * “一点接管游戏就重连一下，但永远接管不上”。
 * 源地址不在本表里时（Clash/TUN 会给出 198.18/16 这种未真正分配的地址）
 * 才回落到命令行传进来的地址，保持旧行为。
 */
static UINT32 local_addrs[MAX_LOCAL_ADDRS];
static UINT local_addr_count = 0;
static ULONGLONG local_addrs_at = 0;

static void refresh_local_addrs(void)
{
    ULONG size = 16384;
    IP_ADAPTER_ADDRESSES *table = NULL;
    ULONG result = ERROR_BUFFER_OVERFLOW;
    UINT count = 0;

    local_addrs_at = GetTickCount64();
    for (int attempt = 0; attempt < 3 && result == ERROR_BUFFER_OVERFLOW; attempt++)
    {
        free(table);
        table = (IP_ADAPTER_ADDRESSES *)malloc(size);
        if (table == NULL) return;
        result = GetAdaptersAddresses(AF_INET,
            GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
            GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_SKIP_FRIENDLY_NAME,
            NULL, table, &size);
    }
    if (result != NO_ERROR)
    {
        free(table);
        return;
    }
    for (IP_ADAPTER_ADDRESSES *adapter = table;
         adapter != NULL && count < MAX_LOCAL_ADDRS; adapter = adapter->Next)
    {
        if (adapter->OperStatus != IfOperStatusUp) continue;
        for (IP_ADAPTER_UNICAST_ADDRESS *unicast = adapter->FirstUnicastAddress;
             unicast != NULL && count < MAX_LOCAL_ADDRS; unicast = unicast->Next)
        {
            if (unicast->Address.lpSockaddr == NULL) continue;
            if (unicast->Address.lpSockaddr->sa_family != AF_INET) continue;
            local_addrs[count++] =
                ((struct sockaddr_in *)unicast->Address.lpSockaddr)->sin_addr.s_addr;
        }
    }
    local_addr_count = count;
    free(table);
}

static BOOL is_local_addr(UINT32 addr)
{
    if (addr == 0) return FALSE;
    for (UINT i = 0; i < local_addr_count; i++)
        if (local_addrs[i] == addr) return TRUE;
    /* 没命中可能只是表旧了（换网、热点刚开、DHCP 续约）：限频刷新后再判一次。 */
    if (GetTickCount64() - local_addrs_at < LOCAL_ADDRS_REFRESH_MS) return FALSE;
    refresh_local_addrs();
    for (UINT i = 0; i < local_addr_count; i++)
        if (local_addrs[i] == addr) return TRUE;
    return FALSE;
}

static DWORD WINAPI connection_watchdog(LPVOID unused)
{
    (void)unused;
    while (TRUE)
    {
        Sleep(250);
        if (first_intercepted && !proxy_confirmed &&
            GetTickCount64() - first_intercepted_at > 5000)
        {
            /* Fail open: never leave the game blocked by a half proxy. */
            if (divert_handle != INVALID_HANDLE_VALUE) WinDivertClose(divert_handle);
            ExitProcess(3);
        }
    }
}

static DWORD WINAPI watch_parent(LPVOID value)
{
    DWORD parent_id = (DWORD)(UINT_PTR)value;
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parent_id);
    if (parent == NULL) return 0;
    WaitForSingleObject(parent, INFINITE);
    CloseHandle(parent);
    if (divert_handle != INVALID_HANDLE_VALUE) WinDivertClose(divert_handle);
    ExitProcess(0);
    return 0;
}

static BOOL WINAPI shutdown_handler(DWORD signal)
{
    (void)signal;
    if (divert_handle != INVALID_HANDLE_VALUE) WinDivertClose(divert_handle);
    ExitProcess(0);
    return TRUE;
}

int __cdecl main(int argc, char **argv)
{
    UINT16 game_port = 12090, proxy_port = 34010, alt_port = 43010;
    UINT32 proxy_addr = htonl(0x7F000001);
    unsigned char packet[MAXBUF];
    WINDIVERT_ADDRESS addr;
    PWINDIVERT_IPHDR ip_header;
    PWINDIVERT_TCPHDR tcp_header;
    UINT packet_len;
    char filter[256];

    DWORD parent_id = 0;
    /* 排障用：不开驱动、不需要管理员，只打印本程序认得的本机 IPv4 地址。
       反射目的地就从这张表里挑，远程排"接管不上"时可以直接和 ipconfig 对照。 */
    if (argc == 2 && strcmp(argv[1], "--dump-local-addrs") == 0)
    {
        refresh_local_addrs();
        for (UINT i = 0; i < local_addr_count; i++)
        {
            struct in_addr shown;
            shown.s_addr = local_addrs[i];
            printf("%s\n", inet_ntoa(shown));
        }
        return 0;
    }
    if (argc == 6)
    {
        game_port = (UINT16)atoi(argv[1]);
        proxy_port = (UINT16)atoi(argv[2]);
        alt_port = (UINT16)atoi(argv[3]);
        proxy_addr = inet_addr(argv[4]);
        parent_id = (DWORD)strtoul(argv[5], NULL, 10);
        if (proxy_addr == INADDR_NONE)
        {
            fprintf(stderr, "invalid proxy address: %s\n", argv[4]);
            return 2;
        }
    }
    else if (argc != 1)
    {
        fprintf(stderr, "usage: %s [game-port proxy-port alt-port proxy-address parent-pid]\n", argv[0]);
        return 2;
    }

    snprintf(filter, sizeof(filter),
        "tcp and (tcp.DstPort == %u or tcp.DstPort == %u or "
        "tcp.SrcPort == %u or tcp.SrcPort == %u)",
        game_port, alt_port, game_port, proxy_port);
    /* Run after Clash/other WinDivert filters so reinjected reflection packets
       go to the TCP stack instead of being captured a second time downstream. */
    divert_handle = WinDivertOpen(filter, WINDIVERT_LAYER_NETWORK, -1000, 0);
    if (divert_handle == INVALID_HANDLE_VALUE)
    {
        fprintf(stderr, "WinDivertOpen failed: %lu\n", GetLastError());
        return 1;
    }
    refresh_local_addrs();
    SetConsoleCtrlHandler(shutdown_handler, TRUE);
    CloseHandle(CreateThread(NULL, 0, connection_watchdog, NULL, 0, NULL));
    if (parent_id != 0) CloseHandle(CreateThread(NULL, 0, watch_parent,
        (LPVOID)(UINT_PTR)parent_id, 0, NULL));

    while (WinDivertRecv(divert_handle, packet, sizeof(packet),
            &packet_len, &addr))
    {
        WinDivertHelperParsePacket(packet, packet_len, &ip_header, NULL, NULL,
            NULL, NULL, &tcp_header, NULL, NULL, NULL, NULL, NULL);
        if (ip_header == NULL || tcp_header == NULL) continue;

        if (addr.Outbound)
        {
            if (tcp_header->DstPort == htons(game_port))
            {
                UINT32 destination = ip_header->DstAddr;
                UINT16 client_port = ntohs(tcp_header->SrcPort);
                connections[client_port].client_addr = ip_header->SrcAddr;
                connections[client_port].server_addr = destination;
                connections[client_port].valid = TRUE;
                if (!first_intercepted)
                {
                    first_intercepted_at = GetTickCount64();
                    InterlockedExchange(&first_intercepted, 1);
                }
                tcp_header->DstPort = htons(proxy_port);
                /*
                 * Reflect to the address this very connection is bound to, so
                 * the injected inbound packet lands on the same interface it
                 * left from (Windows drops it otherwise on multi-homed hosts).
                 * Clash/TUN may expose a synthetic 198.18/16 source address
                 * that is not assigned to any interface — fall back to the
                 * address picked by the caller in that case.
                 */
                ip_header->DstAddr =
                    is_local_addr(ip_header->SrcAddr) ? ip_header->SrcAddr : proxy_addr;
                ip_header->SrcAddr = destination;
                addr.Outbound = FALSE;
                addr.Loopback = FALSE;
            }
            else if (tcp_header->SrcPort == htons(proxy_port))
            {
                UINT16 client_port = ntohs(tcp_header->DstPort);
                if (connections[client_port].valid)
                {
                    if (tcp_header->Syn && tcp_header->Ack)
                        InterlockedExchange(&proxy_confirmed, 1);
                    tcp_header->SrcPort = htons(game_port);
                    ip_header->DstAddr = connections[client_port].client_addr;
                    ip_header->SrcAddr = connections[client_port].server_addr;
                    addr.Outbound = FALSE;
                    addr.Loopback = FALSE;
                }
            }
            else if (tcp_header->DstPort == htons(alt_port))
            {
                tcp_header->DstPort = htons(game_port);
            }
        }
        else if (tcp_header->SrcPort == htons(game_port))
        {
            tcp_header->SrcPort = htons(alt_port);
        }

        WinDivertHelperCalcChecksums(packet, packet_len, &addr, 0);
        if (!WinDivertSend(divert_handle, packet, packet_len, NULL, &addr))
        {
            fprintf(stderr, "WinDivertSend failed: %lu\n", GetLastError());
            break;
        }
    }

    WinDivertClose(divert_handle);
    return 0;
}
