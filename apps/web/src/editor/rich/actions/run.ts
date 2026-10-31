import type { CmdKey } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { callCommand } from '@milkdown/kit/utils';

/**
 * Milkdown assigns a command's key when the editor builds the plugin, not when
 * the module is loaded — so the key has to be read at the moment the command is
 * used. Reading it here, while building the catalogue, captures `undefined` and
 * throws the first time anyone picks something out of the menu.
 */
export const run =
	<T>(command: { key: CmdKey<T> }, payload?: T) =>
	(ctx: Ctx): void => {
		callCommand(command.key, payload)(ctx);
	};
