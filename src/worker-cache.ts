import { quoteRemoteArgument } from "./ssh.ts";

export const NATIVE_WORKER_OWNER = "omp-ssh-remote/native-omp";
export const RETAINED_REMOTE_WORKER_VERSIONS = 2;
const MANIFEST = ".native-worker-v1";

export function validateWorkerCacheIdentity(namespace: string, hash: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(namespace) || namespace === "." || namespace === "..") throw new Error("Invalid worker namespace");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid worker hash");
}

/** Root locking and path validation are shared by deployment leases and collection. */
export function cacheRootSetup(root: string): string {
  return `set -eu; root=${quoteRemoteArgument(root)}; test ! -L "$root"; mkdir -p "$root"; test ! -L "$root/.native-cache.lock"; exec 8>"$root/.native-cache.lock"; flock -w 8 -x 8;`;
}

export function buildWorkerDeploymentLeaseCommand(root: string, namespace: string, hash: string): string {
  validateWorkerCacheIdentity(namespace, hash);
  return `${cacheRootSetup(root)} ns="$root/${namespace}"; d="$ns/${hash}"; test ! -L "$ns"; mkdir -p "$ns"; test ! -L "$d"; mkdir -p "$d"; chmod 700 "$d"; test ! -L "$d/.worker.lock"; exec 9>"$d/.worker.lock"; flock -s 9; if test ! -e "$d/${MANIFEST}"; then test ! -L "$d/.native-pending-v1"; printf 'unadmitted\\n' > "$d/.native-pending-v1"; fi; flock -u 8; printf 'READY\\n'; while IFS= read -r line; do :; done`;
}

/**
 * Fixed, non-executable manifest: owner namespace hash sequence provenance links.
 * Only direct regular native binaries/sidecars and explicitly named symlinks are owned.
 * Unknown direct children make the entire directory non-deletable.
 */
export function buildCommitWorkerCacheCommand(root: string, namespace: string, hash: string, companionLinks: readonly string[] = []): string {
  validateWorkerCacheIdentity(namespace, hash);
  for (const name of companionLinks) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.startsWith("worker") || name === MANIFEST) throw new Error("Invalid worker companion name");
  const links = companionLinks.length ? companionLinks.join(",") : "-";
  return [
    cacheRootSetup(root),
    `current_ns=${quoteRemoteArgument(namespace)}; current_hash='${hash}'; current_links='${links}';`,
    `manifest='${MANIFEST}'; owner='${NATIVE_WORKER_OWNER}';`,
    // Temporary metadata is never sourced, and all paths come from validated direct children.
    'tmp=$(mktemp -d "$root/.native-gc.XXXXXXXX"); trap \'rm -rf -- "$tmp"\' EXIT HUP INT TERM;',
    'valid_ns() { printf "%s\\n" "$1" | grep -Eq "^[A-Za-z0-9][A-Za-z0-9._-]*$"; };',
    'valid_hash() { test "${#1}" -eq 64 && printf "%s\\n" "$1" | grep -Eq "^[a-f0-9]+$"; };',
    'native_layout() {',
    'd=$1; allowed_links=$2; found=0;',
    'test -d "$d" && test ! -L "$d" || return 1;',
    'for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do',
    'test -e "$f" || test -L "$f" || continue; name=${f##*/};',
    'case "$name" in',
    'worker|worker-linux-x64|worker-linux-arm64)',
    'test -f "$f" && test ! -L "$f" && test -x "$f" || return 1; found=1;',
    'test -f "$f.sha256" && test ! -L "$f.sha256" && test "$(cat "$f.sha256")" = "${d##*/}" || return 1;;',
    'worker.sha256|worker-linux-x64.sha256|worker-linux-arm64.sha256)',
    'test -f "$f" && test ! -L "$f" && test -f "${f%.sha256}" && test ! -L "${f%.sha256}" || return 1;;',
    '"$manifest"|.worker.lock|.native-pending-v1) test -f "$f" && test ! -L "$f" || return 1;;',
    '*) test -L "$f" || return 1; case ",$allowed_links," in *",$name,"*) :;; *) return 1;; esac;;',
    'esac; done; test "$found" -eq 1;',
    '};',
    'read_manifest() {',
    'test -f "$1/$manifest" && test ! -L "$1/$manifest" || return 1;',
    // awk validates every field before shell ever uses it; exactly one record.
    `awk -F '\\t' -v owner="$owner" 'NR != 1 || NF != 6 || $1 != owner || $2 !~ /^[A-Za-z0-9][A-Za-z0-9._-]*$/ || length($3) != 64 || $3 !~ /^[a-f0-9]+$/ || $4 !~ /^(0|[1-9][0-9]*)$/ || length($4) > 15 || $5 !~ /^(admitted|imported-mtime)$/ || $6 !~ /^(-|[A-Za-z0-9][A-Za-z0-9._-]*(,[A-Za-z0-9][A-Za-z0-9._-]*)*)$/ { bad=1 } END { exit (bad || NR != 1) }' "$1/$manifest" || return 1;`,
    'IFS="\t" read -r m_owner m_ns m_hash m_seq m_origin m_links < "$1/$manifest";',
    'test "$m_ns" = "$(basename -- "$(dirname -- "$1")")" && test "$m_hash" = "${1##*/}" || return 1;',
    'native_layout "$1" "$m_links";',
    '};',
    'write_manifest() {',
    'printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$owner" "$2" "$3" "$4" "$5" "$6" > "$tmp/manifest";',
    'chmod 600 "$tmp/manifest"; mv -f -- "$tmp/manifest" "$1/$manifest";',
    '};',
    'sequence=0;',
    'if test -e "$root/.native-cache-state" || test -L "$root/.native-cache-state"; then',
    'test -f "$root/.native-cache-state" && test ! -L "$root/.native-cache-state" || exit 1;',
    'sequence=$(cat "$root/.native-cache-state");',
    'printf "%s\\n" "$sequence" | grep -Eq "^(0|[1-9][0-9]{0,14})$" || exit 1;',
    'fi;',
    'for ns in "$root"/*; do test -d "$ns" && test ! -L "$ns" || continue; valid_ns "${ns##*/}" || continue;',
    'for candidate in "$ns"/*; do test -d "$candidate" && test ! -L "$candidate" || continue; valid_hash "${candidate##*/}" || continue;',
    'if read_manifest "$candidate"; then test "$m_seq" -le "$sequence" || sequence=$m_seq; fi;',
    'done; done;',
    // Frozen migration: only omp-1, only the known no-companion native layout, once.
    'if test ! -e "$root/.native-cache-migrated-v1"; then',
    'test ! -L "$root/.native-cache-migrated-v1" || exit 1;',
    'if test -d "$root/omp-1" && test ! -L "$root/omp-1"; then',
    'for candidate in "$root/omp-1"/*; do test -d "$candidate" && test ! -L "$candidate" || continue; valid_hash "${candidate##*/}" || continue;',
    'test ! -e "$candidate/$manifest" && test ! -L "$candidate/$manifest" || continue;',
    'test ! -e "$candidate/.native-pending-v1" && test ! -L "$candidate/.native-pending-v1" || continue;',
    'if native_layout "$candidate" -; then printf "%s\\t%s\\n" "$(stat -c %Y -- "$candidate")" "${candidate##*/}" >> "$tmp/imports"; fi;',
    'done; fi;',
    'if test -f "$tmp/imports"; then sort -n "$tmp/imports" > "$tmp/sorted-imports";',
    'while IFS="\t" read -r imported_time imported_hash; do sequence=$((sequence + 1)); write_manifest "$root/omp-1/$imported_hash" omp-1 "$imported_hash" "$sequence" imported-mtime -; done < "$tmp/sorted-imports"; fi;',
    'printf "completed\\n" > "$root/.native-cache-migrated-v1";',
    'fi;',
    'active="$root/$current_ns/$current_hash";',
    'test -d "$root/$current_ns" && test ! -L "$root/$current_ns" && native_layout "$active" "$current_links" || exit 1;',
    'sequence=$((sequence + 1)); test "$sequence" -lt 999999999999999 || exit 1;',
    'printf "%s\\n" "$sequence" > "$tmp/state"; chmod 600 "$tmp/state"; mv -f -- "$tmp/state" "$root/.native-cache-state";',
    'write_manifest "$active" "$current_ns" "$current_hash" "$sequence" admitted "$current_links";',
    'rm -f -- "$active/.native-pending-v1";',
    'unclassified=0;',
    'for ns in "$root"/*; do test -d "$ns" && test ! -L "$ns" || continue; valid_ns "${ns##*/}" || continue;',
    'for candidate in "$ns"/*; do test -d "$candidate" || test -L "$candidate" || continue; valid_hash "${candidate##*/}" || continue;',
    'if read_manifest "$candidate"; then printf "%s\\t%s\\t%s\\n" "$m_seq" "$m_hash" "$m_ns" >> "$tmp/managed"; else unclassified=$((unclassified + 1)); fi;',
    'done; done;',
    'sort -rn "$tmp/managed" > "$tmp/ordered";',
    // One representative per distinct build; first two distinct hashes form rollback window.
    `awk -F '\\t' '!seen[$2]++ { if (++n <= ${RETAINED_REMOTE_WORKER_VERSIONS}) print $2 }' "$tmp/ordered" > "$tmp/keep";`,
    'retained=0; files=0; bytes=0; deleted=0; deleted_bytes=0; busy=0;',
    ': > "$tmp/retained-hashes"; : > "$tmp/busy-hashes"; : > "$tmp/deleted-hashes"; : > "$tmp/seen";',
    'while IFS="\t" read -r used build namespace; do',
    'candidate="$root/$namespace/$build"; keep=0;',
    'if grep -qx "$build" "$tmp/keep" && ! grep -qx "$build" "$tmp/seen"; then keep=1; fi;',
    'printf "%s\\n" "$build" >> "$tmp/seen";',
    'allocation=0; binary_files=0;',
    'for binary in "$candidate/worker" "$candidate/worker-linux-x64" "$candidate/worker-linux-arm64"; do',
    'test -f "$binary" && test ! -L "$binary" || continue; set -- $(stat -c "%b %B" -- "$binary"); test "$#" -eq 2 || exit 1;',
    'allocation=$((allocation + $1 * $2)); binary_files=$((binary_files + 1)); done;',
    'if test "$keep" -eq 0; then',
    // Root lock is already held; nonblocking exclusive build lock cannot deadlock a deployer.
    'if (exec 9>"$candidate/.worker.lock"; flock -n -x 9 || exit 3;',
    'for exe in /proc/[0-9]*/exe; do target=$(readlink "$exe" 2>/dev/null) || continue; case "$target" in "$candidate/"*) exit 3;; esac; done;',
    'read_manifest "$candidate" || exit 4; rm -rf -- "$candidate"); then',
    'deleted=$((deleted + 1)); deleted_bytes=$((deleted_bytes + allocation)); printf "%s\\n" "$build" >> "$tmp/deleted-hashes"; continue;',
    'else status=$?; if test "$status" -eq 3; then busy=$((busy + 1)); printf "%s\\n" "$build" >> "$tmp/busy-hashes"; else unclassified=$((unclassified + 1)); fi; fi;',
    'fi;',
    'retained=$((retained + 1)); files=$((files + binary_files)); bytes=$((bytes + allocation)); printf "%s\\n" "$build" >> "$tmp/retained-hashes";',
    'done < "$tmp/ordered";',
    'builds=$(sort -u "$tmp/retained-hashes" | wc -l); busy_builds=$(sort -u "$tmp/busy-hashes" | wc -l); deleted_builds=$(grep -vxFf "$tmp/retained-hashes" "$tmp/deleted-hashes" | sort -u | wc -l);',
    'printf "managed\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$builds" "$retained" "$files" "$bytes" "$deleted_builds" "$deleted" "$deleted_bytes" "$busy_builds" "$busy" "$unclassified";',
  ].join(" ");
}
