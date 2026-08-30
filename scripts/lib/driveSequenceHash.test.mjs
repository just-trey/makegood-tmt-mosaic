import { describe, expect, it } from 'vitest';
import { driveSequenceOf, hashDriveSequence } from './driveSequenceHash.mjs';

// Two runs of scripts/system-audit-drive.mjs never produce byte-identical `result.states`: every
// captured value (colors, computed styles, timestamps embedded in outerHTML) can differ without
// the driven sequence itself changing. driveSequenceOf() strips values down to state names,
// captured keys, and selectors before hashing, which is the whole fix — a test that only checked
// "same input -> same hash" would miss a version that still hashed the values.
function statesFixture(overrides = {}) {
  return {
    initial: {
      tokens: { colors: { '--accent': { direct: 'rgb(1, 2, 3)' } } },
      button: {
        selector: '#btn-export',
        outerHTML: '<button>Export</button>',
        style: { color: 'red' },
      },
      dropzoneHover: { selector: '#dropzone', outerHTML: '<div></div>', style: { color: 'blue' } },
    },
    helpDialogOpen: {
      dialog: { selector: '#help-dialog', outerHTML: '<dialog open></dialog>', style: {} },
    },
    ...overrides,
  };
}

describe('driveSequenceOf', () => {
  it('records state names, captured keys, and selectors, not values', () => {
    const sequence = driveSequenceOf(statesFixture());
    expect(sequence).toEqual([
      {
        state: 'initial',
        keys: ['tokens', 'button', 'dropzoneHover'],
        selectors: ['#btn-export', '#dropzone'],
      },
      {
        state: 'helpDialogOpen',
        keys: ['dialog'],
        selectors: ['#help-dialog'],
      },
    ]);
  });
});

describe('hashDriveSequence', () => {
  it('produces the same hash across two runs whose incidental values differ but whose driven sequence is identical', () => {
    const runA = statesFixture();
    const runB = statesFixture({
      initial: {
        tokens: { colors: { '--accent': { direct: 'rgb(9, 9, 9)' } } }, // different measured value
        button: {
          selector: '#btn-export',
          outerHTML: '<button>Different text now</button>',
          style: { color: 'green' },
        },
        dropzoneHover: {
          selector: '#dropzone',
          outerHTML: '<div class="new-class"></div>',
          style: { color: 'purple' },
        },
      },
    });

    const hashA = hashDriveSequence(driveSequenceOf(runA));
    const hashB = hashDriveSequence(driveSequenceOf(runB));

    expect(hashA).toBe(hashB);
  });

  it('produces a different hash when the driven sequence genuinely changes', () => {
    const base = statesFixture();
    const extraState = statesFixture({
      confirmDialogOpen: {
        dialog: { selector: '#confirm-dialog', outerHTML: '<dialog></dialog>', style: {} },
      },
    });
    const differentSelector = statesFixture({
      initial: {
        tokens: { colors: { '--accent': { direct: 'rgb(1, 2, 3)' } } },
        button: {
          selector: '#btn-export-stl',
          outerHTML: '<button>Export</button>',
          style: { color: 'red' },
        },
        dropzoneHover: {
          selector: '#dropzone',
          outerHTML: '<div></div>',
          style: { color: 'blue' },
        },
      },
    });

    const baseHash = hashDriveSequence(driveSequenceOf(base));

    expect(hashDriveSequence(driveSequenceOf(extraState))).not.toBe(baseHash);
    expect(hashDriveSequence(driveSequenceOf(differentSelector))).not.toBe(baseHash);
  });

  it('matches the documented format: 16 lowercase hex characters', () => {
    const hash = hashDriveSequence(driveSequenceOf(statesFixture()));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
