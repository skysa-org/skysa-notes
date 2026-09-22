import { type RefObject } from 'react';

/**
 * The app's search field. It sits in the source bar, at the top of the app,
 * because what it asks is not about the source or the notebook showing: it
 * searches every source on the device and every notebook in them, and its
 * answers take the notes pane. It used to be inside that pane, under the
 * notebook's heading, which said it was the notebook's search.
 */
export interface SearchFieldProps {
	/** What is in the field. Empty means no search is open. */
	query: string;
	onQuery: (query: string) => void;
	/** So a command can put the cursor in the field without hunting the DOM. */
	fieldRef?: RefObject<HTMLInputElement | null>;
	/**
	 * After Escape has emptied the field. The compact bar puts its dropdowns
	 * back then: there the field stands in for them only while it is in use.
	 */
	onDismiss?: () => void;
	/** The field was focused — in the compact bar, the answers come back. */
	onFocus?: () => void;
}

export const SearchField = ({ query, onQuery, fieldRef, onDismiss, onFocus }: SearchFieldProps) => (
	// The landmark is what lets a screen-reader user jump to the field rather
	// than walk the bar to find it.
	<div role="search">
		<input
			ref={fieldRef}
			// `search` rather than `text`: it is what the field is, and the
			// browser offers its own way to empty one.
			type="search"
			className="note-search"
			aria-label="Search notes"
			placeholder="Search notes"
			value={query}
			onChange={(event) => {
				onQuery(event.target.value);
			}}
			onKeyDown={(event) => {
				// Escape puts the user back in the notebook they were in, which
				// is where they were before they typed. Without it the only way
				// out is to delete what they wrote, one character at a time.
				if (event.key !== 'Escape') return;
				onQuery('');
				onDismiss?.();
			}}
			onFocus={onFocus}
		/>
	</div>
);
