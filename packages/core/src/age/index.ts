export { decrypt, encrypt, opens } from './age.js';
export { armor, dearmor, looksArmored } from './armor.js';
export { AgeError, type AgeFailure } from './errors.js';
export { parseRecipient, publicKeyOf, recipientOf } from './curve.js';
export {
	encodeIdentity,
	encodeRecipient,
	generateIdentity,
	parseIdentity,
	spellsRecipient,
} from './keys.js';
