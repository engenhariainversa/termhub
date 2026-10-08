import { defaultDoctorPaths, formatDoctor, runDoctor } from '../doctor.js';

export async function doctorCommand(paths: string[], json: boolean): Promise<void> {
  const targets = paths.length > 0 ? paths : defaultDoctorPaths();
  const report = await runDoctor(targets);

  if (json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(formatDoctor(report));
  }

  const allOk = report.config.ok && report.server.ok && report.tmux.ok && report.nodePty.ok && report.network.ok && report.paths.every((p) => p.ok);
  process.exitCode = allOk ? 0 : 1;
}
