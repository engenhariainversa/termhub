// What "Nova sessão" comes with already chosen (TER-1119), on the TER-1104 rule: preselect only what no
// one would doubt, and leave the rest to the person.
import type { TSessionStartMachine } from '@/services/api/contract';

/** The only online machine of the project; null with none or several (the person picks). */
export function preselectedMachine(machines: TSessionStartMachine[]): string | null {
  const online = machines.filter((m) => m.online);
  return online.length === 1 ? online[0]!.id : null;
}

/** The account the server would pick without asking (`suggested`), else the machine's only one. */
export function preselectedAccount(machine: TSessionStartMachine): string | null {
  if (machine.suggested && machine.choices.some((c) => c.account_id === machine.suggested)) return machine.suggested;
  return machine.choices.length === 1 ? machine.choices[0]!.account_id : null;
}

