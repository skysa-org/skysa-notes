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
	...bar
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
					{...bar}
					query={query}
					onQuery={(next) => {
						setQuery(next);
						// The answers hang from the field, over whatever
						// else is open; a dropdown left open under them
						// would be a second list behind the first. Only
						// when one is: shutting none draws the page again,
						// once, for a letter that changed nothing in it.
						if (bar.panel !== null) bar.onPanel(null);
					}}
				/>
			) : (
				<SourceTabs
					returnTo={returnTo}
					enterCode={enterCode}
					search={
						<NoteSearchField
							query={query}
							onQuery={setQuery}
							onChoose={bar.onChoose}
							sourceName={bar.sourceName}
							showing={bar.showing}
							fieldRef={bar.fieldRef}
						/>
					}
				/>
			)
		}
	</SearchQuery>
);
