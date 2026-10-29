import { type ComponentProps, type ReactNode, useRef } from 'react';

import { t } from '../../i18n/t.js';
import { ConnectChoice } from './connect/ConnectChoice.js';
import { Menu } from './Menu.js';
import { useAdding } from './useAdding.js';
import type { useSourceChoices } from './useSourceChoices.js';

/** What the control that opens it is told, to draw itself by. */
export interface AddButton {
	adding: boolean;
	toggle: () => void;
	/** Nothing connected yet: the control has words, and the menu asks for a provider. */
	first: boolean;
	/** Whether there is any provider to offer, which is whether the menu can open. */
	offering: boolean;
	/** What connecting is called here (`connectLabel`). */
	label: string;
}

/**
 * The way to connect another account: the `+` and the menu it opens, with the
 * gate and a button per provider (`ConnectChoice`). One menu, drawn in the bar
 * beside the tabs and in a compact window's source dropdown, which until #454
 * were two copies of it.
 *
 * Each place draws its own control (`button`): beside the tabs it has its
 * words while nothing is connected, and in the dropdown's header it is an icon
 * that is there, disabled, even with nothing to offer. Neither control's shape
 * is the menu's business; whether it is open is.
 */
export const AddSource = ({
	choices: { offerable, gate, live, connectLabel, first },
	enterCode,
	button,
	...connect
}: Omit<ComponentProps<typeof ConnectChoice>, 'gate' | 'live' | 'openAt' | 'offerable'> & {
	choices: Pick<
		ReturnType<typeof useSourceChoices>,
		'offerable' | 'gate' | 'live' | 'connectLabel' | 'first'
	>;
	/** How many times the app's URL has asked for the code field (`useAdding`). */
	enterCode: number | undefined;
	button: (control: AddButton) => ReactNode;
}) => {
	const offering = offerable.length > 0;
	const { adding, openAt, toggle, stopAdding } = useAdding(enterCode, offering);
	const frame = useRef<HTMLDivElement>(null);
	return (
		<div className="source-add" ref={frame}>
			{button({ adding, toggle, first, offering, label: connectLabel })}
			{adding && (
				<Menu
					className="source-add-menu"
					label={t('sources.providers')}
					frame={frame}
					onClose={stopAdding}
				>
					<p className="source-add-heading">
						{first ? t('sources.chooseProvider') : connectLabel}
					</p>
					<ConnectChoice
						gate={gate}
						live={live}
						openAt={openAt}
						offerable={offerable}
						{...connect}
					/>
				</Menu>
			)}
		</div>
	);
};
