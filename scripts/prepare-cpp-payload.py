"""Extract only pinned regular Debian members; never install packages or follow package links."""
import hashlib
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile


def deb_data(path):
    raw = pathlib.Path(path).read_bytes()
    if raw[:8] != b"!<arch>\n":
        raise ValueError("invalid Debian archive")
    offset = 8
    payload = None
    while offset < len(raw):
        header = raw[offset:offset + 60]
        if len(header) != 60 or header[58:] != b"`\n":
            raise ValueError("invalid ar header")
        size = int(header[48:58])
        name = header[:16].decode("ascii").strip().rstrip("/")
        if size < 0 or offset + 60 + size > len(raw):
            raise ValueError("invalid ar size")
        if name in ("data.tar.xz", "data.tar.gz"):
            if payload is not None:
                raise ValueError("duplicate Debian payload")
            payload = raw[offset + 60:offset + 60 + size]
        offset += 60 + size + size % 2
    if payload is None:
        raise ValueError("missing Debian payload")
    return tarfile.open(fileobj=io.BytesIO(payload), mode="r:*")


def safe_name(name):
    name = name.removeprefix("./")
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or any(ord(c) < 32 for c in name):
        raise ValueError("unsafe Debian member")
    return str(path)


def prepare(sources, pack, arch):
    pack.mkdir()
    for source in sources:
        archive = pathlib.Path(source["archive"])
        if hashlib.sha256(archive.read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError("Debian source checksum mismatch")
        with deb_data(archive) as tar:
            members = {}
            for member in tar.getmembers():
                name = safe_name(member.name)
                if name in members:
                    raise ValueError("duplicate Debian member")
                members[name] = member
            for selection in source["files"]:
                prefix = selection["source"]
                chosen = [(name, member) for name, member in members.items()
                          if name == prefix or (prefix.endswith("/") and name.startswith(prefix))]
                if not chosen:
                    raise ValueError("missing pinned Debian member: " + prefix)
                for name, member in chosen:
                    if member.isdir():
                        continue
                    # Pins name real payload members, not symlinks. No host filesystem link resolution.
                    if not member.isfile() or member.mode & 0o7000 or member.size > 300 * 1024 * 1024:
                        raise ValueError("nonregular or oversized selected member")
                    target = selection["target"] + name[len(prefix):] if prefix.endswith("/") else selection["target"]
                    dest = pack / safe_name(target)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as src, dest.open("xb") as out:
                        out.write(src.read())
                    dest.chmod(0o755 if target == "bin/clangd.real" else 0o644)
    loader = "/lib/ld-linux-aarch64.so.1" if arch == "arm64" else "/lib64/ld-linux-x86-64.so.2"
    launcher = '#!/bin/sh\nset -eu\npack=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd -P)\n'
    launcher += 'exec ' + loader + ' --library-path "$pack/lib" "$pack/bin/clangd.real" "--resource-dir=$pack/lib/clang/23" "$@"\n'
    (pack / "bin/clangd").write_text(launcher)
    (pack / "bin/clangd").chmod(0o755)
    # Builder-side ELF audit covers every private library, not just clangd's direct dependencies.
    allowed = {"libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1", pathlib.Path(loader).name}
    provided = {p.name for p in (pack / "lib").iterdir() if p.is_file()}
    machine = "AArch64" if arch == "arm64" else "Advanced Micro Devices X86-64"
    for path in [pack / "bin/clangd.real", *[p for p in (pack / "lib").iterdir() if p.is_file()]]:
        header = subprocess.check_output(["readelf", "-h", str(path)], text=True)
        if machine not in header:
            raise ValueError("ELF architecture mismatch")
        dynamic = subprocess.check_output(["readelf", "-d", str(path)], text=True)
        needed = set(re.findall(r"\(NEEDED\).*?\[(.*?)\]", dynamic))
        if needed - provided - allowed:
            raise ValueError("unbundled ELF dependency: " + str(needed - provided - allowed))
        versions = subprocess.check_output(["readelf", "--version-info", str(path)], text=True)
        if any(tuple(map(int, v.split("."))) > (2, 29) for v in re.findall(r"\bGLIBC_([0-9.]+)", versions)):
            raise ValueError("ELF requires newer glibc than pinned baseline")


if __name__ == "__main__":
    prepare(json.loads(pathlib.Path(sys.argv[1]).read_text()), pathlib.Path(sys.argv[2]), sys.argv[3])
