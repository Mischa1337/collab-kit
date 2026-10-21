/** The head of a room or a group with rename and delete, and the forms with one text field. */

import { html, nothing, type TemplateResult } from 'lit';

import type { Texts } from '../look/texts.ts';
import type { Form, FormKind } from '../store.ts';

/** Puts the form of this kind where it is called, if that is the one open. */
export type Slot = (
  kind: FormKind,
  placeholder: string,
  label: string,
  value?: string,
) => TemplateResult | typeof nothing;

/** What the forms show, and what they may ask the store for. */
export interface FormsView {
  readonly t: Texts;
  readonly form: Form | undefined;
  readonly busy: boolean;
  openForm(kind: FormKind): void;
  closeForm(): void;
  clearError(): void;
  submit(kind: FormKind, text: string): void;
  removePlace(): void;
}

/** The form of this kind with one text field, if that is the one open. */
export function formView(
  view: FormsView,
  kind: FormKind,
  placeholder: string,
  label: string,
  value = '',
): TemplateResult | typeof nothing {
  const { t, form } = view;
  if (form?.kind !== kind) {
    return nothing;
  }

  // The field is read on submit, so nothing has to follow each key.
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const input = (event.currentTarget as HTMLFormElement).querySelector('input');
    view.submit(kind, input?.value ?? '');
  };

  return html`<form class="form" @submit=${submit}>
      <input
        name="text"
        aria-label=${placeholder}
        placeholder=${placeholder}
        .value=${value}
        @input=${() => view.clearError()}
      />
      <button class="button primary" type="submit" ?disabled=${view.busy}>${label}</button>
      <button class="button" type="button" @click=${() => view.closeForm()}>${t.cancel}</button>
    </form>
    ${errorView(form)}`;
}

/** The name of a room or a group, with rename and delete for whoever holds manage there. */
export function headView(
  view: FormsView,
  name: string,
  manages: boolean,
  nameLabel: string,
  question: string,
): TemplateResult {
  const { t, form } = view;

  return html`
    <div class="head">
      <h2>${name}</h2>
      ${
        manages
          ? html`<span class="actions">
              <button class="link" @click=${() => view.openForm('rename')}>${t.rename}</button>
              <button class="link danger" @click=${() => view.openForm('remove')}>
                ${t.remove}
              </button>
            </span>`
          : nothing
      }
    </div>
    ${formView(view, 'rename', nameLabel, t.save, name)}
    ${
      form?.kind === 'remove'
        ? html`<div class="confirm" role="alert">
              <p>${question}</p>
              <button
                class="button primary"
                ?disabled=${view.busy}
                @click=${() => view.removePlace()}
              >
                ${t.confirmRemove}
              </button>
              <button class="button" @click=${() => view.closeForm()}>${t.cancel}</button>
            </div>
            ${errorView(form)}`
        : nothing
    }
  `;
}

/** What went wrong with the open form, if anything did. */
function errorView(form: Form): TemplateResult | typeof nothing {
  return form.error === undefined ? nothing : html`<p class="error" role="alert">${form.error}</p>`;
}
