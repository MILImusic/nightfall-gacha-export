/*
 * Nightfall TCP redirector, derived from WinDivert's streamdump example.
 * This file is licensed under LGPL-3.0-or-later.
 */
#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include "windivert.h"

#define MAXBUF WINDIVERT_MTU_MAX

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
                 * Clash/TUN may expose a synthetic 198.18/16 source address
                 * that is not assigned to a Windows interface. Reflect to
                 * loopback and remember the original tuple for the return
                 * packet instead of assuming SrcAddr is locally routable.
                 */
                ip_header->DstAddr = proxy_addr;
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
