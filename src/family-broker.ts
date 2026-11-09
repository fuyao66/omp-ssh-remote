import { resolve, sep } from "node:path";

export interface FamilyBrokerMember {
  owner: boolean;
  sessionFile?: string;
}

export interface FamilyBrokerFamily {
  ownerSessionFile: string;
  members: Set<FamilyBrokerMember>;
  closing: boolean;
  generation?: string;
  revocation?: SharedArrayBuffer;
  lineage?: Set<string>;
}

type MemberOf<Family extends FamilyBrokerFamily> = Family["members"] extends Set<infer Member> ? Member : never;

export interface RemoteFamilyBroker<Family extends FamilyBrokerFamily> {
  hasOwner(sessionFile: string): boolean;
  register(family: Family): void;
  find(sessionFile: string): Family | undefined;
  attach(family: Family, member: MemberOf<Family>): void;
  detach(family: Family, member: MemberOf<Family>): void;
  retain(family: Family, sessionFile: string): void;
  revoke(family: Family): void;
}

// Keep the legacy active-family Map in place: already-loaded extension copies
// retain a reference to it. The Map also anchors the single lifecycle owner,
// including revoked descendant roots, across cache-busted module instances.
const ACTIVE_FAMILIES_KEY = Symbol.for("omp-ssh-remote/session-families");
const BROKER_KEY = Symbol.for("omp-ssh-remote/session-family-broker");

type BrokerMap = Map<string, FamilyBrokerFamily> & {
  [BROKER_KEY]?: RemoteFamilyBroker<FamilyBrokerFamily>;
};
type BrokerGlobal = typeof globalThis & { [ACTIVE_FAMILIES_KEY]?: BrokerMap };

export function sessionFamilyRoot(sessionFile: string): string {
  const normalized = resolve(sessionFile);
  return normalized.endsWith(".jsonl")
    ? normalized.slice(0, -".jsonl".length)
    : normalized;
}

export function sessionBelongsToFamily(ownerSessionFile: string, candidateSessionFile: string): boolean {
  return resolve(candidateSessionFile).startsWith(`${sessionFamilyRoot(ownerSessionFile)}${sep}`);
}

/** Shared memory is only a revocation fence, never a transport or a liveness oracle. */
export function familyLease(family: FamilyBrokerFamily): { generation: string; revocation: SharedArrayBuffer } {
  family.generation ??= crypto.randomUUID();
  family.revocation ??= new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  if (family.closing) Atomics.store(new Int32Array(family.revocation), 0, 1);
  return { generation: family.generation, revocation: family.revocation };
}

export function assertFamilyLeaseActive(family: FamilyBrokerFamily): void {
  if (family.closing || (family.revocation && Atomics.load(new Int32Array(family.revocation), 0) !== 0)) {
    throw new Error("Remote runtime family was revoked; local fallback is disabled");
  }
}

class ProcessFamilyBroker implements RemoteFamilyBroker<FamilyBrokerFamily> {
  readonly #active: Map<string, FamilyBrokerFamily>;
  readonly #revoked = new Map<string, FamilyBrokerFamily>();

  constructor(active: Map<string, FamilyBrokerFamily>) {
    this.#active = active;
  }

  hasOwner(sessionFile: string): boolean {
    return this.#active.has(resolve(sessionFile));
  }

  register(family: FamilyBrokerFamily): void {
    familyLease(family);
    this.#active.set(resolve(family.ownerSessionFile), family);
  }

  find(sessionFile: string): FamilyBrokerFamily | undefined {
    let best: FamilyBrokerFamily | undefined;
    let bestRootLength = -1;
    for (const [families, includeRoot] of [[this.#active, false], [this.#revoked, true]] as const) {
      for (const [sessionRoot, family] of families) {
        const rootLength = sessionFamilyRoot(sessionRoot).length;
        if (rootLength <= bestRootLength || !(sessionBelongsToFamily(sessionRoot, sessionFile) ||
            (includeRoot && resolve(sessionRoot) === resolve(sessionFile)))) continue;
        best = family;
        bestRootLength = rootLength;
      }
    }
    return best;
  }

  attach(family: FamilyBrokerFamily, member: FamilyBrokerMember): void {
    family.members.add(member);
    if (!member.owner && member.sessionFile) this.retain(family, member.sessionFile);
    if (family.closing) this.#retainRevokedRoot(family, member);
  }

  detach(family: FamilyBrokerFamily, member: FamilyBrokerMember): void {
    family.members.delete(member);
  }

  retain(family: FamilyBrokerFamily, sessionFile: string): void {
    (family.lineage ??= new Set()).add(resolve(sessionFile));
    if (family.closing) this.#revoked.set(resolve(sessionFile), family);
  }

  revoke(family: FamilyBrokerFamily): void {
    family.closing = true;
    Atomics.store(new Int32Array(familyLease(family).revocation), 0, 1);
    const owner = resolve(family.ownerSessionFile);
    if (this.#active.get(owner) === family) this.#active.delete(owner);
    for (const member of family.members) this.#retainRevokedRoot(family, member);
    for (const root of family.lineage ?? []) this.#revoked.set(root, family);
  }

  #retainRevokedRoot(family: FamilyBrokerFamily, member: FamilyBrokerMember): void {
    if (!member.owner && member.sessionFile) this.#revoked.set(resolve(member.sessionFile), family);
  }

}

export function getRemoteFamilyBroker<Family extends FamilyBrokerFamily>(): RemoteFamilyBroker<Family> {
  const owner = globalThis as BrokerGlobal;
  const active: BrokerMap = (owner[ACTIVE_FAMILIES_KEY] ??= new Map<string, FamilyBrokerFamily>());
  const broker = (active[BROKER_KEY] ??= new ProcessFamilyBroker(active));
  return broker as RemoteFamilyBroker<Family>;
}
