import { resolve, sep } from "node:path";

export interface FamilyBrokerMember {
  owner: boolean;
  sessionFile?: string;
}

export interface FamilyBrokerFamily {
  ownerSessionFile: string;
  members: Set<FamilyBrokerMember>;
  closing: boolean;
}

type MemberOf<Family extends FamilyBrokerFamily> = Family["members"] extends Set<infer Member> ? Member : never;

export interface RemoteFamilyBroker<Family extends FamilyBrokerFamily> {
  hasOwner(sessionFile: string): boolean;
  register(family: Family): void;
  find(sessionFile: string): Family | undefined;
  attach(family: Family, member: MemberOf<Family>): void;
  detach(family: Family, member: MemberOf<Family>): void;
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
    this.#active.set(resolve(family.ownerSessionFile), family);
  }

  find(sessionFile: string): FamilyBrokerFamily | undefined {
    let best: FamilyBrokerFamily | undefined;
    let bestRootLength = -1;
    for (const families of [this.#active, this.#revoked]) {
      for (const [sessionRoot, family] of families) {
        const rootLength = sessionFamilyRoot(sessionRoot).length;
        if (rootLength <= bestRootLength || !sessionBelongsToFamily(sessionRoot, sessionFile)) continue;
        best = family;
        bestRootLength = rootLength;
      }
    }
    return best;
  }

  attach(family: FamilyBrokerFamily, member: FamilyBrokerMember): void {
    family.members.add(member);
    if (family.closing) this.#retainRevokedRoot(family, member);
  }

  detach(family: FamilyBrokerFamily, member: FamilyBrokerMember): void {
    family.members.delete(member);
    this.#releaseRevokedRoots(family);
  }

  revoke(family: FamilyBrokerFamily): void {
    family.closing = true;
    const owner = resolve(family.ownerSessionFile);
    if (this.#active.get(owner) === family) this.#active.delete(owner);
    for (const member of family.members) this.#retainRevokedRoot(family, member);
    this.#releaseRevokedRoots(family);
  }

  #retainRevokedRoot(family: FamilyBrokerFamily, member: FamilyBrokerMember): void {
    if (!member.owner && member.sessionFile) this.#revoked.set(resolve(member.sessionFile), family);
  }

  #releaseRevokedRoots(family: FamilyBrokerFamily): void {
    if (!family.closing || family.members.size !== 0) return;
    for (const [root, revoked] of this.#revoked) {
      if (revoked === family) this.#revoked.delete(root);
    }
  }
}

export function getRemoteFamilyBroker<Family extends FamilyBrokerFamily>(): RemoteFamilyBroker<Family> {
  const owner = globalThis as BrokerGlobal;
  const active: BrokerMap = (owner[ACTIVE_FAMILIES_KEY] ??= new Map<string, FamilyBrokerFamily>());
  const broker = (active[BROKER_KEY] ??= new ProcessFamilyBroker(active));
  return broker as RemoteFamilyBroker<Family>;
}
