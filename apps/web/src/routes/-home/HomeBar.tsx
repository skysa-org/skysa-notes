import { CompactBar, type CompactBarProps } from '../../components/CompactBar.js';
import { NoteSearchField, SearchQuery } from '../../components/SearchField.js';
import { SourceTabs } from '../../components/SourceTabs.js';

/**
 * The bar across the top: in a compact window the dropdowns and the search
 * (`CompactBar`), in a wide one the source tabs with the search beside them
 * (`SourceTabs`). The query is the bar's own (`SearchQuery`), so a letter
 * typed draws the bar and not the shell.
 */
export const HomeBar = ({
	compact,
	returnTo,
	enterCode,
	folder,
	note,
	scratchpad,
	passwords,
	liveEdits,
	renamings,
	panel,
	onPanel,
	onChoose,
	sourceName,
	showing,
	searchOpen,
	onSearchOpen,
	fieldRef,
	onOrigins,
}: Readonly<
	Omit<CompactBarProps, 'query' | 'onQuery'> & {
		compact: boolean;
		/** Where the provider's callback should send the browser back to. */
		returnTo: string;
		/** How many times `?enter=` has asked for the code field (`useEnterCode`). */
		enterCode: number;
	}
>) => (
	<SearchQuery>
		{(query, setQuery) =>
			compact ? (
				<CompactBar
					folder={folder}
					// In the scratchpad, the card open, named after
					// "Scratchpad" if it has a name or words to go by.
					note={note}
					scratchpad={scratchpad}
					passwords={passwords}
					liveEdits={liveEdits}
					renamings={renamings}
					panel={panel}
					onPanel={onPanel}
					query={query}
					onQuery={(next) => {
						setQuery(next);
						// The answers hang from the field, over whatever
						// else is open; a dropdown left open under them
						// would be a second list behind the first. Only
						// when one is: shutting none draws the page again,
						// once, for a letter that changed nothing in it.
						if (panel !== null) onPanel(null);
					}}
					onChoose={onChoose}
					sourceName={sourceName}
					showing={showing}
					searchOpen={searchOpen}
					onSearchOpen={onSearchOpen}
					fieldRef={fieldRef}
					onOrigins={onOrigins}
				/>
			) : (
				<SourceTabs
					returnTo={returnTo}
					enterCode={enterCode}
					search={
						<NoteSearchField
							query={query}
							onQuery={setQuery}
							onChoose={onChoose}
							sourceName={sourceName}
							showing={showing}
							fieldRef={fieldRef}
						/>
					}
				/>
			)
		}
	</SearchQuery>
);
