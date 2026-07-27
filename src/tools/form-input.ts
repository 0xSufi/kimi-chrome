import { fail, ok, type ToolDefinition } from './types';

interface InjectedResult {
  output?: string;
  error?: string;
}

export const formInputTool: ToolDefinition = {
  name: 'form_input',
  description: 'Set the value of a form element by ref. Handles inputs, textareas, selects, checkboxes, radios, ranges, dates.',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string' },
      value: { description: 'String, boolean, or number depending on element type' },
      tabId: { type: 'number' },
    },
    required: ['ref', 'value'],
  },

  async execute(args, ctx) {
    const ref = args.ref as string;
    const value = args.value;
    const tabId = (args.tabId as number) ?? ctx.tabId;

    if (!ref) return fail('ref parameter is required');
    if (value === undefined || value === null) return fail('value parameter is required');

    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (refId: string, val: unknown): InjectedResult => {
        const map = (window as unknown as { __dyspelElementMap?: Record<string, WeakRef<Element>> }).__dyspelElementMap;
        if (!map?.[refId]) return { error: `Element ${refId} not found` };

        const el = map[refId].deref();
        if (!el) return { error: `Element ${refId} is no longer in the DOM` };

        el.scrollIntoView({ behavior: 'smooth', block: 'center' });

        const fire = (type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
        const tag = el.tagName.toLowerCase();
        const inputType = ((el as HTMLInputElement).type ?? '').toLowerCase();

        if (tag === 'select') {
          const select = el as HTMLSelectElement;
          const options = Array.from(select.options);
          const match = options.find((o) => o.value === String(val) || o.textContent?.trim() === String(val));
          if (!match) return { error: `Option "${val}" not found in dropdown` };
          const prev = select.value;
          select.value = match.value;
          fire('change'); fire('input');
          return { output: `Selected "${match.textContent?.trim()}" (was "${prev}")` };
        }

        if (tag === 'input' && inputType === 'checkbox') {
          if (typeof val !== 'boolean') return { error: 'Checkbox value must be boolean' };
          const input = el as HTMLInputElement;
          const prev = input.checked;
          input.checked = val;
          fire('change'); fire('input');
          return { output: `Checkbox ${val ? 'checked' : 'unchecked'} (was ${prev})` };
        }

        if (tag === 'input' && inputType === 'radio') {
          (el as HTMLInputElement).checked = true;
          fire('change'); fire('input');
          return { output: `Radio selected in group "${(el as HTMLInputElement).name || 'unnamed'}"` };
        }

        if (tag === 'input' && inputType === 'range') {
          if (typeof val !== 'number') return { error: 'Range value must be a number' };
          const input = el as HTMLInputElement;
          const min = parseFloat(input.min) || 0;
          const max = parseFloat(input.max) || 100;
          if (val < min || val > max) return { error: `Value ${val} is outside [${min}, ${max}]` };
          const prev = input.value;
          input.value = String(val);
          fire('change'); fire('input');
          return { output: `Range set to ${val} (was ${prev})` };
        }

        if (['date', 'time', 'datetime-local', 'month', 'week'].includes(inputType)) {
          const input = el as HTMLInputElement;
          const prev = input.value;
          input.value = String(val);
          fire('change'); fire('input');
          return { output: `${inputType} set to "${val}" (was "${prev}")` };
        }

        const input = el as HTMLInputElement | HTMLTextAreaElement;
        const prev = input.value ?? '';
        input.value = String(val);
        (input as HTMLElement).focus();
        fire('input'); fire('change');
        const preview = String(val).slice(0, 50);
        return { output: `Typed "${preview}" into ${tag} (was "${prev.slice(0, 50)}")` };
      },
      args: [ref, value],
    });

    const data: InjectedResult | undefined = r?.result;
    if (!data) return fail('Failed to set form value');
    if (data.error) return fail(data.error);
    return ok(data.output ?? '');
  },
};
