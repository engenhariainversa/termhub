import { deleteConfig } from '../config.js';
import { deleteDeviceKey } from '../device-key.js';

export function disconnectCommand(): void {
  deleteConfig();
  deleteDeviceKey();
  console.log('Configuração removida. Revogue o acesso no app (Parear de novo, ou exclua a máquina).');
}
