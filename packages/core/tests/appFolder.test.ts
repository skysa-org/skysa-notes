import { describe, expect, it } from 'vitest';

import {
	isClipPath,
	isEncryptionFile,
	isPassedOver,
	isScratchPath,
	isVaultPath,
	NOTES_WATCH,
	syncsHidden,
} from '../src/appFolder.js';

describe('isScratchPath', () => {
	it('is the scratchpad folder and what is in it, and nothing else', () => {
		expect(isScratchPath('.scratchpad')).toBe(true);
		expect(isScratchPath('.scratchpad/untitled.md')).toBe(true);
		expect(isScratchPath('scratchpad/untitled.md')).toBe(false);
		expect(isScratchPath('.scratchpadding/a.md')).toBe(false);
		expect(isScratchPath('work/a.md')).toBe(false);
	});
});

describe('isVaultPath', () => {
	it('is the vault’s folder and what is in it, and nothing else', () => {
		expect(isVaultPath('.vault')).toBe(true);
		expect(isVaultPath('.vault/github.md')).toBe(true);
		expect(isVaultPath('vault/github.md')).toBe(false);
		expect(isVaultPath('.vaulted/a.md')).toBe(false);
		expect(isVaultPath('.scratchpad/a.md')).toBe(false);
	});
});

describe('isClipPath', () => {
	it('is the clipboard’s folder and what is in it, the folder itself included', () => {
		expect(isClipPath('.clipboard')).toBe(true);
		expect(isClipPath('.clipboard/a.txt')).toBe(true);
		expect(isClipPath('.clipboards/a.txt')).toBe(false);
		expect(isClipPath('Work/.clipboard/a.txt')).toBe(false);
	});
});

describe('isEncryptionFile', () => {
	it('is at the root and nowhere else', () => {
		expect(isEncryptionFile('.encryption.json')).toBe(true);
		expect(isEncryptionFile('/.encryption.json')).toBe(true);
		expect(isEncryptionFile('notes/.encryption.json')).toBe(false);
		expect(isEncryptionFile('.encryption.json.bak')).toBe(false);
	});
});

describe('syncsHidden and isPassedOver', () => {
	// What the sync engine is handed of this app's hidden folders, and the rule
	// that makes of `isHidden`: the scratchpad's and the vault's folders sync,
	// and nothing dot-named inside them, nor anything else hidden.
	it('lets the scratchpad at the root through, and nothing hidden inside it', () => {
		expect(syncsHidden('.scratchpad')).toBe(true);
		expect(isPassedOver('.scratchpad')).toBe(false);
		expect(isPassedOver('.scratchpad/untitled.md')).toBe(false);
		expect(isPassedOver('.scratchpad/pasted-image-3f9a1c2b.png')).toBe(false);
		expect(isPassedOver('.scratchpad/.DS_Store')).toBe(true);
		expect(isPassedOver('work/.scratchpad/a.md')).toBe(true);
		expect(isPassedOver('.Scratchpad/a.md')).toBe(true);
		expect(isPassedOver('.clipboard/a.txt')).toBe(true);
	});

	it('lets the vault’s passwords at the root through, and nothing hidden inside them', () => {
		expect(syncsHidden('.vault')).toBe(true);
		expect(isPassedOver('.vault')).toBe(false);
		expect(isPassedOver('.vault/github.md')).toBe(false);
		expect(isPassedOver('.vault/.DS_Store')).toBe(true);
		expect(isPassedOver('work/.vault/a.md')).toBe(true);
		expect(isPassedOver('.Vault/a.md')).toBe(true);
		expect(isPassedOver('.vaults/a.md')).toBe(true);
		expect(isPassedOver('.encryption.json')).toBe(true);
	});

	it('passes over anything else hidden, and nothing that is not', () => {
		expect(isPassedOver('.notesapp.json')).toBe(true);
		expect(isPassedOver('work/.hidden.md')).toBe(true);
		expect(isPassedOver('work/standup.md')).toBe(false);
		expect(syncsHidden('work/standup.md')).toBe(false);
	});
});

describe('NOTES_WATCH', () => {
	it('names the clipboard’s folder and the key file, which a pull says it met', () => {
		expect(Object.keys(NOTES_WATCH)).toEqual(['clipboard', 'encryption']);
		expect(NOTES_WATCH.clipboard('.clipboard/a.txt')).toBe(true);
		expect(NOTES_WATCH.encryption('.encryption.json')).toBe(true);
		expect(NOTES_WATCH.clipboard('.encryption.json')).toBe(false);
	});
});
