import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
	type Answer,
	browserDeviceLock,
	type DeviceLock,
	type Made,
	setUpDeviceLock,
} from '../src/secrets/deviceLock.js';

/**
 * The device's own lock (docs/ARCHITECTURE.md §7, "The device's own lock,
 * where there is one"): a passkey made on this device, asked for what its
 * PRF extension answers a salt, after the device's own check. jsdom has no
 * WebAuthn, so the browser's half is the answers it is given here.
 */

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(navigator, 'credentials');
});

const answer = (fill: number) => new Uint8Array(32).fill(fill);

/** A credential as the browser gives one: its id, and what its extensions said. */
const credential = (prf: AuthenticationExtensionsPRFOutputs | undefined) => ({
	rawId: new Uint8Array([9, 9, 9]).buffer,
	getClientExtensionResults: () => (prf === undefined ? {} : { prf }),
});

/** `navigator.credentials.create` or `get`, as the browser answers it. */
type Asked = Mock<(options: unknown) => Promise<unknown>>;

const browserWith = ({
	capabilities,
	platform = true,
	create = vi.fn<(options: unknown) => Promise<unknown>>(),
	get = vi.fn<(options: unknown) => Promise<unknown>>(),
	signal,
}: {
	capabilities?: Record<string, boolean>;
	platform?: boolean;
	create?: Asked;
	get?: Asked;
	signal?: Asked;
}) => {
	vi.stubGlobal('PublicKeyCredential', {
		...(capabilities === undefined
			? {}
			: { getClientCapabilities: () => Promise.resolve(capabilities) }),
		...(signal === undefined ? {} : { signalUnknownCredential: signal }),
		isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(platform),
	});
	Object.defineProperty(navigator, 'credentials', {
		value: { create, get },
		configurable: true,
	});
	return { create, get };
};

describe('whether the device’s lock is offered', () => {
	it('is not, where the browser has no WebAuthn', async () => {
		expect(await browserDeviceLock().offered()).toBe(false);
	});

	it.each<[string, Record<string, boolean> | undefined, boolean, boolean]>([
		[
			'says it answers a salt, with a lock of its own',
			{ 'extension:prf': true, userVerifyingPlatformAuthenticator: true },
			false,
			true,
		],
		[
			'says it answers a salt, with no lock of its own',
			{ 'extension:prf': true, userVerifyingPlatformAuthenticator: false },
			true,
			false,
		],
		['says it answers a salt, and nothing of a lock', { 'extension:prf': true }, true, true],
		[
			'says it does not answer a salt',
			{ 'extension:prf': false, userVerifyingPlatformAuthenticator: true },
			true,
			false,
		],
		// Safari says only what its platform tells it: making the passkey settles it.
		['says nothing of a salt', { userVerifyingPlatformAuthenticator: true }, true, true],
		['cannot say, and has a lock of its own', undefined, true, true],
		['cannot say, and has no lock of its own', undefined, false, false],
	])('where the browser %s', async (_, capabilities, platform, offered) => {
		browserWith({ capabilities, platform });
		expect(await browserDeviceLock().offered()).toBe(offered);
	});

	it('is not, where asking fails', async () => {
		vi.stubGlobal('PublicKeyCredential', {
			getClientCapabilities: () => Promise.reject(new Error('no')),
		});
		expect(await browserDeviceLock().offered()).toBe(false);
	});
});

describe('making the passkey', () => {
	const salt = new Uint8Array(32).fill(1);

	it('asks for one on this device, checked by the device, made to answer the salt, and asks nothing of the API', async () => {
		const { create } = browserWith({});
		create.mockResolvedValue(
			credential({ enabled: true, results: { first: answer(3).buffer } })
		);
		const fetching = vi.spyOn(globalThis, 'fetch');

		const made = await browserDeviceLock().create(salt, 'Unlocks secrets on this device: Work');

		expect(made).toEqual({
			state: 'made',
			credentialId: new Uint8Array([9, 9, 9]).buffer,
			answer: answer(3),
		});
		const [{ publicKey }] = create.mock.calls[0] as [CredentialCreationOptions];
		expect(publicKey).toMatchObject({
			user: {
				name: 'Unlocks secrets on this device: Work',
				displayName: 'Unlocks secrets on this device: Work',
			},
			authenticatorSelection: {
				authenticatorAttachment: 'platform',
				userVerification: 'required',
			},
			attestation: 'none',
			timeout: 60_000,
			extensions: { prf: { eval: { first: salt } } },
		});
		expect(publicKey?.rp.id).toBeUndefined();
		expect(fetching).not.toHaveBeenCalled();
	});

	it('is made with no answer, where making it answered nothing', async () => {
		const { create } = browserWith({});
		create.mockResolvedValue(credential({ enabled: true }));

		const made = await browserDeviceLock().create(salt, 'name');

		expect(made).toEqual({ state: 'made', credentialId: new Uint8Array([9, 9, 9]).buffer });
	});

	it.each<[string, AuthenticationExtensionsPRFOutputs | undefined]>([
		['says it cannot answer a salt', { enabled: false }],
		['says nothing of a salt', undefined],
	])('cannot keep a key, where the passkey %s, and names it to be let go of', async (_, prf) => {
		const { create } = browserWith({});
		create.mockResolvedValue(credential(prf));

		expect(await browserDeviceLock().create(salt, 'name')).toEqual({
			state: 'unsupported',
			credentialId: new Uint8Array([9, 9, 9]).buffer,
		});
	});

	it('is refused, where the user or the browser says no', async () => {
		const { create } = browserWith({});
		create.mockRejectedValue(new DOMException('no', 'NotAllowedError'));

		expect(await browserDeviceLock().create(salt, 'name')).toEqual({ state: 'refused' });
	});
});

describe('asking the passkey', () => {
	const salt = new Uint8Array(32).fill(1);
	const id = new Uint8Array([9, 9, 9]).buffer;

	it('asks that passkey alone, on this device, after its check, for what it answers the salt', async () => {
		const { get } = browserWith({});
		get.mockResolvedValue(credential({ results: { first: answer(4).buffer } }));

		expect(await browserDeviceLock().answer(id, salt)).toEqual(answer(4));
		const [{ publicKey }] = get.mock.calls[0] as [CredentialRequestOptions];
		expect(publicKey).toMatchObject({
			allowCredentials: [{ type: 'public-key', id, transports: ['internal'] }],
			userVerification: 'required',
			timeout: 60_000,
			extensions: { prf: { eval: { first: salt } } },
		});
	});

	it.each<[string, () => Promise<unknown>, Answer]>([
		[
			'the user or the browser says no',
			() => Promise.reject(new DOMException('no', 'NotAllowedError')),
			'refused',
		],
		['nothing comes back', () => Promise.resolve(null), 'refused'],
		['it answers nothing for the salt', () => Promise.resolve(credential({})), 'unsupported'],
		[
			'it answers with the wrong size',
			() => Promise.resolve(credential({ results: { first: new Uint8Array(16).buffer } })),
			'unsupported',
		],
	])('has no answer where %s', async (_, got, said) => {
		const { get } = browserWith({});
		get.mockImplementation(got);

		expect(await browserDeviceLock().answer(id, salt)).toBe(said);
	});

	it.each([
		['its answer', 32],
		['an answer of the wrong size', 16],
	])('fills the browser’s own copy of %s with zeros, once it is taken', async (_, size) => {
		const given = new Uint8Array(size).fill(4);
		const { get } = browserWith({});
		get.mockResolvedValue(credential({ results: { first: given } }));

		const got = await browserDeviceLock().answer(id, salt);

		expect(given.every((byte) => byte === 0)).toBe(true);
		if (size === 32) expect(got).toEqual(answer(4));
	});
});

describe('letting go of a passkey', () => {
	it('says it is unknown, as its id, where the browser lets that be said', async () => {
		const signal = vi.fn<(options: unknown) => Promise<unknown>>(() => Promise.resolve());
		browserWith({ signal });

		await browserDeviceLock().forget(new Uint8Array([251, 239, 255, 9]).buffer);

		expect(signal).toHaveBeenCalledWith({ rpId: location.hostname, credentialId: '--__CQ' });
	});

	it('does nothing where it cannot be said, and nothing comes of it failing', async () => {
		browserWith({});
		await expect(
			browserDeviceLock().forget(new Uint8Array([1]).buffer)
		).resolves.toBeUndefined();

		browserWith({ signal: vi.fn(() => Promise.reject(new Error('no'))) });
		await expect(
			browserDeviceLock().forget(new Uint8Array([1]).buffer)
		).resolves.toBeUndefined();

		vi.unstubAllGlobals();
		await expect(
			browserDeviceLock().forget(new Uint8Array([1]).buffer)
		).resolves.toBeUndefined();
	});
});

describe('setting the device’s lock up', () => {
	const id = new Uint8Array([7]).buffer;

	/** The bytes of each passkey `lock` was told to let go of, in turn. */
	const forgotten = (lock: DeviceLock) =>
		vi.mocked(lock.forget).mock.calls.map(([each]) => [...new Uint8Array(each)]);

	/** A device lock whose passkey answers each ask in turn with `answers`, and refuses after. */
	const lockWith = (made: Made, answers: readonly Answer[]) => {
		const asked = { current: 0 };
		const lock: DeviceLock = {
			offered: () => Promise.resolve(true),
			create: vi.fn(() => Promise.resolve(made)),
			answer: vi.fn(() => {
				const next = answers[asked.current] ?? 'refused';
				asked.current += 1;
				return Promise.resolve(typeof next === 'string' ? next : Uint8Array.from(next));
			}),
			forget: vi.fn(() => Promise.resolve()),
		};
		return lock;
	};

	it('asks once more, where making the passkey answered, and takes the answers that agree', async () => {
		const lock = lockWith({ state: 'made', credentialId: id, answer: answer(5) }, [answer(5)]);

		const set = await setUpDeviceLock(lock, 'name');

		expect(set.state).toBe('set');
		expect(lock.answer).toHaveBeenCalledTimes(1);
		expect(lock.forget).not.toHaveBeenCalled();
		const [salt] = vi.mocked(lock.create).mock.calls[0] ?? [];
		expect(salt).toHaveLength(32);
		if (set.state !== 'set') return;
		expect(set.unlock).toMatchObject({ kind: 'device', credentialId: id, answer: answer(5) });
		expect(new Uint8Array(set.unlock.salt)).toEqual(salt);
		expect(vi.mocked(lock.answer).mock.calls[0]?.[1]).toEqual(salt);
	});

	it('asks twice, where making the passkey answered nothing', async () => {
		const lock = lockWith({ state: 'made', credentialId: id }, [answer(6), answer(6)]);

		const set = await setUpDeviceLock(lock, 'name');

		expect(set.state).toBe('set');
		expect(lock.answer).toHaveBeenCalledTimes(2);
	});

	it('cannot keep a key with a passkey that answers otherwise the next time, and lets go of both answers', async () => {
		const first = answer(5);
		const lock = lockWith({ state: 'made', credentialId: id, answer: first }, [answer(6)]);

		expect(await setUpDeviceLock(lock, 'name')).toEqual({ state: 'unsupported' });
		const second = (await vi.mocked(lock.answer).mock.results[0]?.value) as Uint8Array;
		expect(second).toHaveLength(32);
		expect([first, second].every((each) => each.every((byte) => byte === 0))).toBe(true);
		expect(forgotten(lock)).toEqual([[7]]);
	});

	it('cannot keep a key with answers of different lengths, however they begin', async () => {
		const lock = lockWith(
			{ state: 'made', credentialId: id, answer: new Uint8Array(16).fill(5) },
			[answer(5)]
		);

		expect(await setUpDeviceLock(lock, 'name')).toEqual({ state: 'unsupported' });
	});

	it('is refused where the passkey is not made, and has nothing to let go of', async () => {
		const lock = lockWith({ state: 'refused' }, []);
		expect(await setUpDeviceLock(lock, 'name')).toEqual({ state: 'refused' });
		expect(lock.forget).not.toHaveBeenCalled();
	});

	it.each<[string, Made, readonly Answer[], 'refused' | 'unsupported']>([
		[
			'the first ask is not answered',
			{ state: 'made', credentialId: id },
			['refused'],
			'refused',
		],
		[
			'the check is not answered',
			{ state: 'made', credentialId: id, answer: answer(5) },
			['refused'],
			'refused',
		],
		[
			'the first ask is answered with nothing for the salt',
			{ state: 'made', credentialId: id },
			['unsupported'],
			'unsupported',
		],
		[
			'the check is answered with nothing for the salt',
			{ state: 'made', credentialId: id },
			[answer(5), 'unsupported'],
			'unsupported',
		],
	])('lets go of the passkey made, where %s', async (_, made, answers, said) => {
		const lock = lockWith(made, answers);
		expect(await setUpDeviceLock(lock, 'name')).toEqual({ state: said });
		expect(forgotten(lock)).toEqual([[7]]);
	});

	it('says a passkey that cannot answer cannot keep a key, and lets go of it', async () => {
		const lock = lockWith({ state: 'unsupported', credentialId: id }, []);
		expect(await setUpDeviceLock(lock, 'name')).toEqual({ state: 'unsupported' });
		expect(forgotten(lock)).toEqual([[7]]);

		const none = lockWith({ state: 'unsupported' }, []);
		expect(await setUpDeviceLock(none, 'name')).toEqual({ state: 'unsupported' });
		expect(none.forget).not.toHaveBeenCalled();
	});

	it('lets go of the first answer where asking for the second fails', async () => {
		const first = answer(5);
		const lock = lockWith({ state: 'made', credentialId: id, answer: first }, []);
		vi.mocked(lock.answer).mockRejectedValueOnce(new Error('no'));

		await expect(setUpDeviceLock(lock, 'name')).rejects.toThrow('no');

		expect(first.every((byte) => byte === 0)).toBe(true);
	});

	it('lets go of the first answer, which it kept only to compare', async () => {
		const first = answer(5);
		const lock = lockWith({ state: 'made', credentialId: id, answer: first }, [answer(5)]);

		await setUpDeviceLock(lock, 'name');

		expect(first.every((byte) => byte === 0)).toBe(true);
	});
});
