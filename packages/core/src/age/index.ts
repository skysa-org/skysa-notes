export { decrypt, encrypt, opens } from './age.js';
export { armor, dearmor, looksArmored } from './armor.js';
export { AgeError, type AgeFailure } from './errors.js';
export {
	encodeIdentity,
	encodeRecipient,
	generateIdentity,
	parseIdentity,
	parseRecipient,
	publicKeyOf,
	recipientOf,
	spellsRecipient,
} from './keys.js';
