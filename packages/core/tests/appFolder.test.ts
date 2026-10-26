import { describe, expect, it } from 'vitest';

import { isClipPath, isEncryptionFile, isScratchPath, isVaultPath } from '../src/appFolder.js';

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
