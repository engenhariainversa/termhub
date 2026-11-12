// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combobox, foldText, matchRange, placePanel, type ComboboxOption } from './Combobox';
import { Modal } from './Modal';

const REPOS: ComboboxOption[] = [
  { value: 'the-door-app/ccroad' },
  { value: 'a-supernova/financeiro' },
  { value: 'a-supernova/financeiro-api' },
  { value: 'auvp/São-Paulo', hint: 'Superapp' },
];

const onChange = vi.fn();

function Field(props: Partial<Parameters<typeof Combobox>[0]>) {
  const [value, setValue] = useState(props.value ?? '');
  return (
    <Combobox
      aria-label="Repo"
      options={REPOS}
      {...props}
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

const trigger = () => screen.getByRole('button', { name: 'Repo' });
const filter = () => screen.getByRole('combobox');
const optionTexts = () => screen.getAllByRole('option').map((o) => o.textContent);
const type = (text: string) => fireEvent.change(filter(), { target: { value: text } });

afterEach(() => {
  cleanup();
  onChange.mockClear();
});

describe('Combobox', () => {
  it('focuses an empty filter on open and takes nothing from the browser', () => {
    render(<Field />);
    fireEvent.click(trigger());
    expect(filter()).toHaveFocus();
    expect(filter()).toHaveValue('');
    expect(filter()).toHaveAttribute('autocomplete', 'off');
    expect(filter()).not.toHaveAttribute('name');
    expect(filter()).not.toHaveAttribute('list');
    expect(document.querySelector('datalist')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('filters ignoring case and accents, also by the hint, and highlights the match', () => {
    render(<Field />);
    fireEvent.click(trigger());
    type('FIN');
    expect(optionTexts()).toEqual(['a-supernova/financeiro', 'a-supernova/financeiro-api']);
    expect(screen.getAllByRole('option')[0]!.querySelector('mark')).toHaveTextContent('fin');
    type('sao');
    expect(optionTexts()).toEqual(['auvp/São-PauloSuperapp']);
    expect(screen.getByRole('option').querySelector('mark')).toHaveTextContent('São');
    type('superapp');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('says when nothing matched, and when the list is loading', () => {
    const { rerender } = render(<Combobox aria-label="Repo" value="" onChange={onChange} options={REPOS} />);
    fireEvent.click(trigger());
    type('zzz');
    expect(screen.getByText('Nada encontrado')).toBeInTheDocument();
    rerender(<Combobox aria-label="Repo" value="" onChange={onChange} options={REPOS} loading />);
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    expect(screen.queryByText('Nada encontrado')).not.toBeInTheDocument();
  });

  it('asks for the options each time it opens', () => {
    const onOpen = vi.fn();
    render(<Field onOpen={onOpen} />);
    fireEvent.click(trigger());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('walks the list with the arrows, wraps, marks aria-activedescendant and picks with Enter', () => {
    render(<Field />);
    fireEvent.click(trigger());
    const activeId = () => filter().getAttribute('aria-activedescendant');
    const options = screen.getAllByRole('option');
    expect(activeId()).toBe(options[0]!.id);
    fireEvent.keyDown(filter(), { key: 'ArrowDown' });
    expect(activeId()).toBe(options[1]!.id);
    fireEvent.keyDown(filter(), { key: 'ArrowUp' });
    fireEvent.keyDown(filter(), { key: 'ArrowUp' });
    expect(activeId()).toBe(options[3]!.id);
    fireEvent.keyDown(filter(), { key: 'ArrowDown' });
    fireEvent.keyDown(filter(), { key: 'ArrowDown' });
    fireEvent.keyDown(filter(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('a-supernova/financeiro');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('Enter takes the first match after filtering; a click picks too', () => {
    render(<Field />);
    fireEvent.click(trigger());
    type('fin');
    fireEvent.keyDown(filter(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('a-supernova/financeiro');
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: 'the-door-app/ccroad' }));
    expect(onChange).toHaveBeenLastCalledWith('the-door-app/ccroad');
  });

  it('opens from the keyboard, seeding the filter with the letter typed on the closed field', () => {
    render(<Field />);
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(filter()).toHaveValue('');
    fireEvent.keyDown(filter(), { key: 'Escape' });
    fireEvent.keyDown(trigger(), { key: 'f' });
    expect(filter()).toHaveValue('f');
    expect(optionTexts()).toEqual(['a-supernova/financeiro', 'a-supernova/financeiro-api']);
  });

  it('Esc closes without changing the value, and gives focus back', () => {
    render(<Field />);
    fireEvent.click(trigger());
    type('fin');
    fireEvent.keyDown(filter(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
  });

  it('a click outside closes without choosing', () => {
    render(<Field />);
    fireEvent.click(trigger());
    type('fin');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Tab leaves the panel back to the field, so the page order goes on from there', () => {
    render(<Field />);
    fireEvent.click(trigger());
    fireEvent.keyDown(filter(), { key: 'Tab' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never offers a value off the list unless asked to', () => {
    render(<Field />);
    fireEvent.click(trigger());
    type('owner/novo');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.keyDown(filter(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  describe('free text', () => {
    it('offers what was typed, and Enter takes it when nothing else matches', () => {
      render(<Field allowFreeText />);
      fireEvent.click(trigger());
      type('owner/novo');
      expect(optionTexts()).toEqual(['Usar "owner/novo"']);
      fireEvent.keyDown(filter(), { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('owner/novo');
      expect(trigger()).toHaveTextContent('owner/novo');
    });

    it('with partial matches, Enter still takes the first one and the arrow reaches the typed text', () => {
      render(<Field allowFreeText />);
      fireEvent.click(trigger());
      type('fin');
      expect(optionTexts()).toEqual(['a-supernova/financeiro', 'a-supernova/financeiro-api', 'Usar "fin"']);
      fireEvent.keyDown(filter(), { key: 'ArrowUp' });
      fireEvent.keyDown(filter(), { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('fin');
    });

    it('does not offer a text that is already an option', () => {
      render(<Field allowFreeText />);
      fireEvent.click(trigger());
      type('A-SUPERNOVA/FINANCEIRO');
      expect(optionTexts()).toEqual(['a-supernova/financeiro', 'a-supernova/financeiro-api']);
    });

    it('opens with the current value without filtering by it', () => {
      render(<Field allowFreeText value="owner/antigo" />);
      fireEvent.click(trigger());
      expect(filter()).toHaveValue('owner/antigo');
      expect(screen.getAllByRole('option')).toHaveLength(4);
      fireEvent.keyDown(filter(), { key: 'Enter' });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('keeps what was typed when leaving with Tab or a click outside, like a text field; Esc discards', () => {
      render(<Field allowFreeText />);
      fireEvent.click(trigger());
      type('owner/um');
      fireEvent.keyDown(filter(), { key: 'Tab' });
      expect(onChange).toHaveBeenLastCalledWith('owner/um');
      fireEvent.click(trigger());
      type('owner/dois');
      fireEvent.pointerDown(document.body);
      expect(onChange).toHaveBeenLastCalledWith('owner/dois');
      fireEvent.click(trigger());
      type('owner/tres');
      fireEvent.keyDown(filter(), { key: 'Escape' });
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    it('erasing the text and pressing Enter empties the field', () => {
      render(<Field allowFreeText value="owner/antigo" />);
      fireEvent.click(trigger());
      type('');
      fireEvent.keyDown(filter(), { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('');
    });
  });

  it('inside a modal: Esc closes only the panel, and a click in the panel stays in the modal', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Janela" open onClose={onClose}>
        <Field />
      </Modal>,
    );
    fireEvent.click(trigger());
    expect(filter().closest('[role="dialog"]')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('option', { name: 'the-door-app/ccroad' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(filter(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Repo' })).toHaveFocus();
    fireEvent.keyDown(trigger(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is named by a <label>, and the description still gives the value', () => {
    render(
      <>
        <label htmlFor="m">Máquina</label>
        <Combobox id="m" value="b" onChange={onChange} options={[{ value: 'b', label: 'jarvis' }]} />
      </>,
    );
    expect(screen.getByLabelText('Máquina')).toHaveAccessibleDescription('jarvis');
  });

  it('shows the placeholder while empty, and a value off the list as it is', () => {
    const { rerender } = render(<Combobox aria-label="Repo" value="" placeholder="owner/repo" onChange={onChange} options={REPOS} />);
    expect(trigger()).toHaveTextContent('owner/repo');
    rerender(<Combobox aria-label="Repo" value="x/y" placeholder="owner/repo" onChange={onChange} options={REPOS} />);
    expect(trigger()).toHaveTextContent('x/y');
  });
});

describe('placePanel', () => {
  const viewport = { width: 1000, height: 800 };
  const rect = (top: number, left = 100, width = 300) => ({ top, bottom: top + 36, left, width });

  it('opens under the field, with its width, when it fits', () => {
    expect(placePanel(rect(100), 5, viewport)).toEqual({ left: 100, width: 300, top: 140, maxHeight: 320 });
  });

  it('opens over the field when there is no room below', () => {
    expect(placePanel(rect(700), 20, viewport)).toEqual({ left: 100, width: 300, bottom: 104, maxHeight: 320 });
  });

  it('stays under when below is still the larger side, shrinking to the room there is', () => {
    expect(placePanel(rect(250), 20, { width: 1000, height: 560 })).toEqual({ left: 100, width: 300, top: 290, maxHeight: 262 });
  });

  it('never leaves the viewport sideways, and a narrow field gets a usable width', () => {
    expect(placePanel(rect(100, 900, 80), 1, viewport)).toMatchObject({ left: 792, width: 200 });
    expect(placePanel(rect(100, 0, 500), 1, { width: 320, height: 800 })).toMatchObject({ left: 8, width: 304 });
  });
});

describe('text helpers', () => {
  it('foldText drops case and accents', () => {
    expect(foldText('São JOÃO')).toBe('sao joao');
  });

  it('matchRange maps back to the original text, composed or decomposed', () => {
    expect(matchRange('São Paulo', 'sao')).toEqual([0, 3]);
    expect(matchRange('São Paulo', 'sao')).toEqual([0, 4]);
    expect(matchRange('São Paulo', 'paulo')).toEqual([5, 10]);
    expect(matchRange('abc', 'x')).toBeNull();
    expect(matchRange('abc', '')).toBeNull();
  });
});
