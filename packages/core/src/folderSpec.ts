/**
 * What an app calls the folder it owns on a provider, and how it recognises
 * it again: handed to the adapters by the app rather than imported, so that
 * the layers bound for the shared kit name no app of their own
 * (docs/decisions/0018-the-shared-kit.md). Every value here is in the user's
 * storage already, so an app hands over the same values for as long as there
 * are libraries that hold them: renamed, every folder already connected is
 * one the app cannot find. This app's are `NOTES_FOLDER`, in `config.ts`.
 */
export interface AppFolderSpec {
	/**
	 * The folder's name, where the app makes the folder by name: Google Drive.
	 * OneDrive and Dropbox name it after the app's registration, which has to
	 * be made under this same name (docs/ARCHITECTURE.md §12.1).
	 */
	readonly name: string;
	/**
	 * The `appProperties` key Google Drive tags the folder with, and finds it
	 * by whatever it is called (docs/ARCHITECTURE.md §5.1). With `Left` after
	 * it, the key of the mark on a folder the app has left.
	 */
	readonly driveTag: string;
	/** The file written once at the folder's root (docs/ARCHITECTURE.md §3). */
	readonly marker: MarkerSpec;
}

export interface MarkerSpec {
	/** Its name, at the root of the folder. */
	readonly file: string;
	/** The app it names as its own; a marker naming another is not this app's. */
	readonly app: string;
	/** The folder's layout version this app writes, and the newest it reads. */
	readonly version: number;
}
