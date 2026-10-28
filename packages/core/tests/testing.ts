/**
 * Core's test doubles and helpers, for the apps' tests: `@skysa/core/testing`.
 * Kept out of the main entry so nothing the app ships can reach them, and the
 * lint rule in `eslint.config.js` keeps it that way.
 */
export {
	createFakeProvider,
	type FakeCall,
	type FakeFault,
	type FakeOperation,
	type FakeProvider,
	type FakeProviderOptions,
} from '../src/providers/fake.js';
export { createDropboxStub, type DropboxStub } from './providers/dropboxStub.js';
export {
	createGDriveStub,
	type GDriveStub,
	type GDriveStubOptions,
} from './providers/gdriveStub.js';
export {
	createOneDriveStub,
	type OneDriveStub,
	type OneDriveStubOptions,
} from './providers/onedriveStub.js';
export { describeSyncStoreContract, type StoreHarness } from './sync/storeContract.js';
export { mulberry32 } from './support/random.js';
