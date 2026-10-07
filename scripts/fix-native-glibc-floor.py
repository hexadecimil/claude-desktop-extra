#!/usr/bin/env python3
"""Keep upstream's claude-native-binding.node loadable on the glibc 2.34 floor.

v2.19675.1's binding referenced `pidfd_spawnp` / `pidfd_getpid`
(GLIBC_2.39); v2.26454.0's tops out at GLIBC_2.34 and passes through
unchanged, so this stays as a guard for the next release that raises it.
Those were weak undefined symbols, so the code already coped with them
being absent, but the matching libc.so.6 version-need entry carries no
flags, and ld.so refuses the whole file when libc lacks that version
(`version 'GLIBC_2.39' not found`) - RHEL 9, Ubuntu 22.04 and Debian 12. The
binding then fails to load and every safe-fs operation throws.

For each libc.so.6 version-need above GLIBC_2.34 this sets VER_FLG_WEAK, after
verifying that every dynamic symbol bound to that version is weak. A strong
symbol on such a version cannot be neutralized this way and fails the build.

Usage: fix-native-glibc-floor.py <dir>   (searched recursively for
claude-native-binding.node; at least one must be found)
"""

import struct
import sys
from pathlib import Path

FLOOR = (2, 34)
VER_FLG_WEAK = 0x2
SHT_DYNSYM = 11
SHT_GNU_VERNEED = 0x6FFFFFFE
SHT_GNU_VERSYM = 0x6FFFFFFF
STB_WEAK = 2
SHN_UNDEF = 0
MACHINES = {62: "x86_64", 183: "aarch64"}


def fail(msg):
    print(f"  [FAIL] {msg}")
    sys.exit(1)


def cstr(b, off):
    return bytes(b[off : b.index(0, off)]).decode()


def glibc_version(name):
    if not name.startswith("GLIBC_"):
        return None
    try:
        return tuple(int(p) for p in name[6:].split("."))
    except ValueError:
        return None


def fix(path):
    b = bytearray(path.read_bytes())
    if b[:4] != b"\x7fELF" or b[4] != 2 or b[5] != 1:
        fail(f"{path}: not an ELF64 little-endian file")
    machine = struct.unpack_from("<H", b, 18)[0]
    if machine not in MACHINES:
        fail(f"{path}: unexpected e_machine {machine}")
    shoff = struct.unpack_from("<Q", b, 0x28)[0]
    shentsize, shnum = struct.unpack_from("<HH", b, 0x3A)
    # (type, offset, size, link, entsize)
    secs = []
    for i in range(shnum):
        f = struct.unpack_from("<IIQQQQIIQQ", b, shoff + i * shentsize)
        secs.append((f[1], f[4], f[5], f[6], f[9]))
    by_type = {}
    for s in secs:
        by_type.setdefault(s[0], []).append(s)
    if len(by_type.get(SHT_GNU_VERNEED, [])) != 1:
        fail(f"{path}: expected exactly one .gnu.version_r section")
    if len(by_type.get(SHT_DYNSYM, [])) != 1 or len(by_type.get(SHT_GNU_VERSYM, [])) != 1:
        fail(f"{path}: expected exactly one .dynsym and one .gnu.version")

    # libc.so.6 vernaux entries above the floor: version index -> (name, flags offset)
    _, vn_off, _, vn_link, _ = by_type[SHT_GNU_VERNEED][0]
    vn_str = secs[vn_link][1]
    above = {}
    off = vn_off
    while True:
        _, cnt, file_, aux, nxt = struct.unpack_from("<HHIII", b, off)
        if cstr(b, vn_str + file_) == "libc.so.6":
            a = off + aux
            for _ in range(cnt):
                _, _, other, name, anext = struct.unpack_from("<IHHII", b, a)
                nm = cstr(b, vn_str + name)
                v = glibc_version(nm)
                if v is not None and v > FLOOR:
                    above[other] = (nm, a + 4)
                if not anext:
                    break
                a += anext
        if not nxt:
            break
        off += nxt

    arch = MACHINES[machine]
    if not above:
        print(f"  [OK] {path} ({arch}): no libc version above GLIBC_{FLOOR[0]}.{FLOOR[1]}, nothing to do")
        return

    # Every dynamic symbol bound to one of those versions must be a weak undefined.
    _, ds_off, ds_size, ds_link, ds_ent = by_type[SHT_DYNSYM][0]
    ds_str = secs[ds_link][1]
    vs_off = by_type[SHT_GNU_VERSYM][0][1]
    bound = {idx: [] for idx in above}
    for i in range(ds_size // ds_ent):
        e = ds_off + i * ds_ent
        name, info, _, shndx = struct.unpack_from("<IBBH", b, e)
        ver = struct.unpack_from("<H", b, vs_off + 2 * i)[0] & 0x7FFF
        if ver not in bound:
            continue
        sym = cstr(b, ds_str + name)
        if info >> 4 != STB_WEAK or shndx != SHN_UNDEF:
            fail(f"{path} ({arch}): {sym}@{above[ver][0]} is not a weak undefined symbol - cannot neutralize, re-audit")
        bound[ver].append(sym)

    for idx, (nm, flags_off) in sorted(above.items(), key=lambda kv: kv[1][0]):
        syms = ", ".join(sorted(bound[idx])) or "no symbols"
        flags = struct.unpack_from("<H", b, flags_off)[0]
        if flags & VER_FLG_WEAK:
            print(f"  [OK] {path} ({arch}): {nm} already weak ({syms})")
            continue
        struct.pack_into("<H", b, flags_off, flags | VER_FLG_WEAK)
        print(f"  [OK] {path} ({arch}): {nm} version-need marked weak ({syms})")
    path.write_bytes(b)

    # Re-read and assert the end state.
    c = path.read_bytes()
    for nm, flags_off in above.values():
        if not struct.unpack_from("<H", c, flags_off)[0] & VER_FLG_WEAK:
            fail(f"{path}: {nm} still not weak after write")


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    found = sorted(Path(sys.argv[1]).rglob("claude-native-binding.node"))
    if not found:
        fail(f"no claude-native-binding.node under {sys.argv[1]} - the .deb layout moved")
    for p in found:
        fix(p)


if __name__ == "__main__":
    main()
