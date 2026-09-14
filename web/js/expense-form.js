import * as api from './api.js';
import {
  CURRENCIES,
  alertBox,
  field,
  formatMoney,
  h,
  openModal,
  render,
  toMajorString,
  toMinorUnits,
  toast,
  withPending,
} from './ui.js';

/**
 * Add or edit an expense, covering all four split types the API accepts.
 *
 * The interesting part is the split editor: `exact` and `percentage` splits
 * have to add up, and finding that out only after a failed round trip is a
 * miserable way to fill in a form. So the totals are checked live here and
 * again on the server, which stays the authority (docs/05-SECURITY.md §5).
 */

const SPLIT_TYPES = /** @type {const} */ ([
  ['equal', 'Equal', 'Everyone selected pays the same share.'],
  ['exact', 'Exact', 'Type each person’s exact amount. They must add up to the total.'],
  ['percentage', 'Percent', 'Type each person’s percentage. They must add up to 100%.'],
  ['shares', 'Shares', 'Weight the split — 2 shares pays twice what 1 share pays.'],
]);

/**
 * Proportional allocation preview, largest remainder first.
 *
 * Presentational only: it exists so the form can show roughly what each
 * person will owe before submitting, and every figure it produces is marked
 * with "≈". The amounts that get stored are the ones `debt-simplify`
 * computes server-side, and the created expense comes back with them.
 *
 * @param {number} total
 * @param {Array<[string, number]>} weights
 * @returns {Map<string, number>}
 */
function estimate(total, weights) {
  const sum = weights.reduce((acc, [, weight]) => acc + weight, 0);
  if (!(sum > 0) || !(total > 0)) return new Map();

  /** @type {Map<string, number>} */
  const out = new Map();
  /** @type {Array<[string, number]>} */
  const remainders = [];
  let allocated = 0;

  for (const [id, weight] of weights) {
    const exact = (total * weight) / sum;
    const floored = Math.floor(exact);
    out.set(id, floored);
    allocated += floored;
    remainders.push([id, exact - floored]);
  }

  remainders.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (let i = 0; i < total - allocated && remainders.length > 0; i += 1) {
    const [id] = remainders[i % remainders.length];
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/**
 * @param {{
 *   groupId: string,
 *   members: Array<{id: string, displayName: string}>,
 *   currentUserId: string,
 *   expense?: any,
 *   onSaved: () => Promise<void> | void,
 * }} options
 */
export function openExpenseForm({ groupId, members, currentUserId, expense = null, onSaved }) {
  const editing = Boolean(expense);

  const amountInput = h('input', {
    class: 'input input--money',
    type: 'text',
    inputmode: 'decimal',
    required: true,
    placeholder: '0.00',
    value: expense ? toMajorString(expense.amount, expense.currency) : '',
  });

  const currencySelect = h(
    'select',
    { class: 'select' },
    CURRENCIES.map((code) =>
      h('option', { value: code, selected: code === (expense?.currency ?? 'USD') }, code),
    ),
  );

  const descriptionInput = h('input', {
    class: 'input',
    type: 'text',
    maxLength: 280,
    required: true,
    placeholder: 'Hotel, dinner, taxi…',
    value: expense?.description ?? '',
  });

  const paidBySelect = h(
    'select',
    { class: 'select' },
    members.map((member) =>
      h(
        'option',
        {
          value: member.id,
          selected: member.id === (expense?.paidBy ?? currentUserId),
        },
        member.id === currentUserId ? `${member.displayName} (you)` : member.displayName,
      ),
    ),
  );

  /** Which split type is active, and who is included with what weight. */
  let splitType = /** @type {string} */ (expense?.splitType ?? 'equal');

  /** @type {Map<string, {included: boolean, value: string}>} */
  const rows = new Map(
    members.map((member) => {
      const existing = expense?.splits?.find((s) => s.userId === member.id);
      return [
        member.id,
        {
          included: expense ? Boolean(existing) : true,
          value: existing && expense ? toMajorString(existing.amount, expense.currency) : '',
        },
      ];
    }),
  );

  const splitSlot = h('div');
  const errorSlot = h('div');

  const currency = () => currencySelect.value;
  const totalMinor = () => toMinorUnits(amountInput.value, currency());

  /** Included rows as [userId, numericWeight] pairs for the active type. */
  function weights() {
    /** @type {Array<[string, number]>} */
    const out = [];
    for (const [id, row] of rows) {
      if (!row.included) continue;
      if (splitType === 'equal') out.push([id, 1]);
      else if (splitType === 'exact') out.push([id, toMinorUnits(row.value, currency()) || 0]);
      else out.push([id, Number(row.value) || 0]);
    }
    return out;
  }

  /** @returns {{ok: boolean, message: string, tone: 'ok' | 'error' | 'idle'}} */
  function status() {
    const included = weights();
    const total = totalMinor();

    if (included.length === 0) {
      return { ok: false, message: 'Select at least one person', tone: 'error' };
    }
    if (!Number.isFinite(total) || total <= 0) {
      return { ok: false, message: 'Enter an amount first', tone: 'idle' };
    }

    if (splitType === 'exact') {
      const sum = included.reduce((acc, [, value]) => acc + value, 0);
      const diff = total - sum;
      if (diff === 0) return { ok: true, message: 'Adds up exactly', tone: 'ok' };
      return {
        ok: false,
        message:
          diff > 0
            ? `${formatMoney(diff, currency())} left to assign`
            : `${formatMoney(-diff, currency())} over the total`,
        tone: 'error',
      };
    }

    if (splitType === 'percentage') {
      const sum = included.reduce((acc, [, value]) => acc + value, 0);
      const rounded = Math.round(sum * 100) / 100;
      if (Math.abs(rounded - 100) < 0.01) return { ok: true, message: '100%', tone: 'ok' };
      return { ok: false, message: `${rounded}% of 100%`, tone: 'error' };
    }

    if (splitType === 'shares') {
      const sum = included.reduce((acc, [, value]) => acc + value, 0);
      if (sum <= 0) return { ok: false, message: 'Give someone at least one share', tone: 'error' };
      return { ok: true, message: `${sum} share${sum === 1 ? '' : 's'} total`, tone: 'ok' };
    }

    return {
      ok: true,
      message: `${included.length} ${included.length === 1 ? 'person' : 'people'}`,
      tone: 'ok',
    };
  }

  function drawSplit() {
    const total = totalMinor();
    const preview = estimate(Number.isFinite(total) ? total : 0, weights());
    const state = status();

    const description = SPLIT_TYPES.find(([value]) => value === splitType)?.[2] ?? '';

    render(
      splitSlot,
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Split')),

      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Split type' },
        SPLIT_TYPES.map(([value, label]) => [
          h('input', {
            type: 'radio',
            name: 'split-type',
            id: `split-${value}`,
            checked: splitType === value,
            onChange: () => {
              splitType = value;
              // Amounts typed for one split type mean nothing under another,
              // so start the values clean rather than carry nonsense across.
              for (const row of rows.values()) row.value = '';
              drawSplit();
            },
          }),
          h('label', { for: `split-${value}` }, label),
        ]),
      ),

      h('p', { class: 'field__hint', style: { marginBlock: '0.5rem' } }, description),

      h(
        'div',
        { class: 'split-rows' },
        members.map((member) => {
          const row = rows.get(member.id);
          if (!row) return null;

          const checkbox = h('input', {
            type: 'checkbox',
            checked: row.included,
            'aria-label': `Include ${member.displayName}`,
            onChange: (event) => {
              row.included = event.currentTarget.checked;
              drawSplit();
            },
          });

          const share = preview.get(member.id);

          return h(
            'div',
            { class: 'split-row' },
            h(
              'label',
              { class: 'split-row__who' },
              checkbox,
              h(
                'span',
                { class: 'split-row__name' },
                member.id === currentUserId ? `${member.displayName} (you)` : member.displayName,
              ),
            ),
            h(
              'div',
              { class: 'split-row__value' },
              splitType === 'equal'
                ? h(
                    'span',
                    { class: 'split-row__preview' },
                    row.included && share !== undefined ? `≈ ${formatMoney(share, currency())}` : '—',
                  )
                : [
                    h('input', {
                      class: 'input input--money',
                      type: 'text',
                      inputmode: 'decimal',
                      value: row.value,
                      disabled: !row.included,
                      'aria-label': `${member.displayName} ${splitType}`,
                      onInput: (event) => {
                        row.value = event.currentTarget.value;
                        updateStatus();
                      },
                      // Redraw on blur so the estimates refresh without the
                      // field losing focus mid-typing.
                      onBlur: () => drawSplit(),
                    }),
                    h(
                      'span',
                      { class: 'split-row__unit' },
                      splitType === 'percentage' ? '%' : splitType === 'shares' ? '×' : '',
                    ),
                  ],
            ),
          );
        }),
        h(
          'div',
          { class: 'split-total', dataset: { ok: String(state.tone === 'ok') } },
          h('span', null, splitType === 'exact' ? 'Assigned' : 'Total'),
          h('span', null, state.message),
        ),
      ),
    );
  }

  /** Cheap update of just the running-total line while someone types. */
  function updateStatus() {
    const line = splitSlot.querySelector('.split-total');
    if (!(line instanceof HTMLElement)) return;
    const state = status();
    line.dataset.ok = String(state.tone === 'ok');
    const value = line.lastElementChild;
    if (value) value.textContent = state.message;
  }

  amountInput.addEventListener('input', updateStatus);
  amountInput.addEventListener('blur', drawSplit);
  currencySelect.addEventListener('change', drawSplit);

  /** Assemble the request body the API expects. */
  function buildSplit() {
    const included = [...rows.entries()].filter(([, row]) => row.included);

    if (splitType === 'equal') {
      return { type: 'equal', participants: included.map(([id]) => id) };
    }
    if (splitType === 'exact') {
      return {
        type: 'exact',
        amounts: Object.fromEntries(
          included.map(([id, row]) => [id, toMinorUnits(row.value, currency()) || 0]),
        ),
      };
    }
    if (splitType === 'percentage') {
      return {
        type: 'percentage',
        percentages: Object.fromEntries(included.map(([id, row]) => [id, Number(row.value) || 0])),
      };
    }
    return {
      type: 'shares',
      shares: Object.fromEntries(
        included.map(([id, row]) => [id, Math.trunc(Number(row.value)) || 0]),
      ),
    };
  }

  const submit = h('button', { class: 'btn', type: 'submit' }, editing ? 'Save changes' : 'Add expense');

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        render(errorSlot);

        const amount = totalMinor();
        if (!Number.isFinite(amount) || amount <= 0) {
          render(errorSlot, alertBox('Enter an amount greater than zero.'));
          amountInput.focus();
          return;
        }
        if (!descriptionInput.value.trim()) {
          render(errorSlot, alertBox('Describe what this expense was for.'));
          descriptionInput.focus();
          return;
        }

        const state = status();
        if (!state.ok) {
          render(errorSlot, alertBox(`The split does not add up: ${state.message.toLowerCase()}.`));
          return;
        }

        const payload = {
          amount,
          currency: currency(),
          description: descriptionInput.value.trim(),
          paidBy: paidBySelect.value,
          split: buildSplit(),
        };

        try {
          await withPending(submit, () =>
            editing ? api.updateExpense(expense.id, payload) : api.createExpense(groupId, payload),
          );
          dialog.close();
          toast(editing ? 'Expense updated' : 'Expense added', 'success');
          await onSaved();
        } catch (error) {
          render(
            errorSlot,
            alertBox(
              error instanceof api.ApiError ? error.message : 'Could not save. Is the API running?',
            ),
          );
        }
      },
    },

    h(
      'div',
      { class: 'form-grid form-grid--2' },
      field({ label: 'Amount', input: amountInput }),
      field({ label: 'Currency', input: currencySelect }),
    ),
    field({ label: 'Description', input: descriptionInput }),
    field({ label: 'Paid by', input: paidBySelect }),
    splitSlot,
    errorSlot,
  );

  const dialog = openModal({
    title: editing ? 'Edit expense' : 'Add an expense',
    body: form,
    actions: [
      h(
        'button',
        { class: 'btn btn--secondary', type: 'button', onClick: () => dialog.close() },
        'Cancel',
      ),
      submit,
    ],
  });

  submit.addEventListener('click', () => form.requestSubmit());
  drawSplit();
  amountInput.focus();
}
