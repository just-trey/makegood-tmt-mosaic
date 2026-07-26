import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  ASSEMBLY_KINDS,
  asmKindCanAutoLoad,
  currentVariantId,
  roleLibraryPartId,
} from '../src/assembly/kinds';
import { state } from '../src/state/store';
import type { AssemblyRole, LibraryEntry } from '../src/types';

const chair = ASSEMBLY_KINDS.find((k) => k.id === 'chair-body')!;
const role = (id: string): AssemblyRole => chair.roles.find((r) => r.id === id)!;

const manifest: { id: string }[] = JSON.parse(
  readFileSync(
    resolve(fileURLToPath(new URL('.', import.meta.url)), '../public/stl/parts.json'),
    'utf8',
  ),
);
const manifestIds = new Set(manifest.map((e) => e.id));

afterEach(() => {
  state.assembly.kindId = null;
  state.assembly.variantId = null;
  state.assembly.library = [];
});

describe('chair-body kind shape', () => {
  it('is hidden, rect, with 13 roles and Standard/Kit variants', () => {
    expect(chair.hidden).toBe(true);
    expect(chair.designFit).toBe('rect');
    expect(chair.roles).toHaveLength(13);
    expect(chair.variants?.map((v) => v.id)).toEqual(['standard', 'kit']);
  });

  it('has exactly two variant-dependent roles (the caster mounts)', () => {
    const variantRoles = chair.roles.filter((r) => r.libraryPartIdByVariant);
    expect(variantRoles.map((r) => r.id).sort()).toEqual(['caster-left', 'caster-right']);
  });

  it('every resolved library part id exists in the shipped manifest', () => {
    for (const r of chair.roles) {
      for (const variantId of ['standard', 'kit']) {
        const id = roleLibraryPartId(r, variantId);
        expect(id, `${r.id} @ ${variantId}`).toBeTruthy();
        expect(manifestIds.has(id!), `${id} in parts.json`).toBe(true);
      }
    }
  });
});

describe('roleLibraryPartId', () => {
  it('ignores the variant for a plain role', () => {
    expect(roleLibraryPartId(role('handle-left'), 'standard')).toBe('chair-handle-left');
    expect(roleLibraryPartId(role('handle-left'), 'kit')).toBe('chair-handle-left');
    expect(roleLibraryPartId(role('handle-left'), null)).toBe('chair-handle-left');
  });

  it('picks the per-variant piece for a variant role', () => {
    expect(roleLibraryPartId(role('caster-left'), 'standard')).toBe('chair-caster-std-left');
    expect(roleLibraryPartId(role('caster-left'), 'kit')).toBe('chair-caster-kit-left');
    expect(roleLibraryPartId(role('caster-right'), 'standard')).toBe('chair-caster-std-right');
    expect(roleLibraryPartId(role('caster-right'), 'kit')).toBe('chair-caster-kit-right');
  });

  it('returns undefined for a variant role when no variant is chosen', () => {
    expect(roleLibraryPartId(role('caster-left'), null)).toBeUndefined();
    expect(roleLibraryPartId(role('caster-left'), 'nonesuch')).toBeUndefined();
  });
});

describe('currentVariantId', () => {
  it('defaults to the first variant when none is chosen', () => {
    state.assembly.kindId = 'chair-body';
    state.assembly.variantId = null;
    expect(currentVariantId()).toBe('standard');
  });

  it('honors a valid choice and ignores an invalid one', () => {
    state.assembly.kindId = 'chair-body';
    state.assembly.variantId = 'kit';
    expect(currentVariantId()).toBe('kit');
    state.assembly.variantId = 'bogus';
    expect(currentVariantId()).toBe('standard');
  });

  it('is null for a kind with no variants', () => {
    state.assembly.kindId = 'wheel';
    state.assembly.variantId = 'kit'; // stale from a prior chair session
    expect(currentVariantId()).toBeNull();
  });
});

describe('asmKindCanAutoLoad with variants', () => {
  const libraryFor = (ids: string[]): LibraryEntry[] =>
    ids.map((id) => ({ id, name: id, file: `stl/${id}.3mf` }));

  it('needs the chosen variant’s caster present, not the other', () => {
    state.assembly.kindId = 'chair-body';
    state.assembly.variantId = 'standard';
    // everything except the caster mounts, then only the Standard casters
    const shared = chair.roles.filter((r) => r.libraryPartId).map((r) => r.libraryPartId!);
    state.assembly.library = libraryFor([
      ...shared,
      'chair-caster-std-left',
      'chair-caster-std-right',
    ]);
    expect(asmKindCanAutoLoad(chair)).toBe(true);

    // switching to Kit, whose casters aren't in the library, blocks auto-load
    state.assembly.variantId = 'kit';
    expect(asmKindCanAutoLoad(chair)).toBe(false);
  });

  it('auto-loads when the full manifest is present, for either variant', () => {
    state.assembly.kindId = 'chair-body';
    state.assembly.library = libraryFor([...manifestIds]);
    state.assembly.variantId = 'standard';
    expect(asmKindCanAutoLoad(chair)).toBe(true);
    state.assembly.variantId = 'kit';
    expect(asmKindCanAutoLoad(chair)).toBe(true);
  });
});
