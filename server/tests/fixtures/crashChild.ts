/**
 * Child process of crashReports.test.ts: installs the backend's fatal-error handlers, edits the live document through the command
 * bus, then dies of an uncaught exception or an unhandled rejection (argv[2] = 'exception' | 'rejection').
 */
import { installFatalErrorHandlers } from '../../src/lifecycle';
import { applyCommand } from '../../src/commandBus';

if (require.main === module) {
  installFatalErrorHandlers();
  applyCommand('add_box', { size: [10, 20, 30] });
  applyCommand('add_cylinder', { radius: 4, height: 8, position: [30, 0, 0] });
  setTimeout(() => {
    if (process.argv[2] === 'rejection') void Promise.reject(new Error('crash child rejected'));
    else throw new Error('crash child exploded');
  }, 10);
}
