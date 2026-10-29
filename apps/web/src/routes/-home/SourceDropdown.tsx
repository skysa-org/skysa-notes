import { AccountPanel } from '../../components/account/AccountPanel.js';
import { SourcePanel } from '../../components/sources/SourcePanel.js';
import type { Renamings } from '../../store/renaming.js';
/**
 * What the source dropdown opens, in a compact window only: the sources, the
 * way to another account, and the storage panel a wide window keeps under the
 * notebooks, with its actions in the dropdown's `⋯`.
 */
export const SourceDropdown = ({
	compact,
	returnTo,
	onChosen,
	renamings,
	enterCode,
}: {
	compact: boolean;
	returnTo: string;
	onChosen: () => void;
	renamings: Renamings;
	enterCode: number;
}) =>
	compact ? (
		<SourcePanel
			returnTo={returnTo}
			renamings={renamings}
			enterCode={enterCode}
			account={(slot) => <AccountPanel slot={slot} />}
			onChosen={onChosen}
		/>
	) : null;
