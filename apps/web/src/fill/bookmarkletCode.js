(c) => {
	const tokens = (input) => (input.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
	const usable = (input) =>
		!input.disabled &&
		!input.readOnly &&
		input.getClientRects().length > 0 &&
		getComputedStyle(input).visibility !== 'hidden';
	const find = () => {
		const all = Array.from(document.querySelectorAll('input')).filter(usable);
		const form = document.activeElement && document.activeElement.form;
		const own = form ? all.filter((input) => input.form === form) : [];
		const scope = own.some((input) => input.type === 'password') ? own : all;
		const secret = scope.filter((input) => input.type === 'password');
		const password =
			secret.find((input) => tokens(input).includes('current-password')) ||
			secret.find((input) => !tokens(input).includes('new-password'));
		const fresh = secret.find((input) => tokens(input).includes('new-password'));
		const plain = scope.filter((input) => ['text', 'email', 'tel'].includes(input.type));
		const before = password
			? plain.filter(
					(input) =>
						input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING
				)
			: plain;
		const username =
			before.find((input) =>
				tokens(input).some((token) => token === 'username' || token === 'email')
			) ||
			before.filter((input) =>
				/user|e-?mail|login|account/i.test(`${input.name} ${input.id}`)
			)[0] ||
			(password ? before[before.length - 1] : before.length === 1 ? before[0] : undefined);
		return { username, password, fresh };
	};
	const setterOf = (prototype) =>
		prototype
			? (Object.getOwnPropertyDescriptor(prototype, 'value') || {}).set ||
				setterOf(Object.getPrototypeOf(prototype))
			: undefined;
	const put = (input, value) => {
		const set =
			input && typeof value === 'string' ? setterOf(Object.getPrototypeOf(input)) : undefined;
		if (!set) return;
		set.call(input, value);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
	};
	const typed = find();
	const win = open(`${c.app}/fill`, '_blank', 'popup,width=440,height=640');
	if (!win) {
		alert(c.blocked);
		return;
	}
	const hear = (event) => {
		const data = event.data;
		if (event.source !== win || event.origin !== c.app || !data || data.type !== c.type) return;
		if (data.step === 'ready') {
			win.postMessage(
				{
					type: c.type,
					v: c.v,
					b: c.b,
					step: 'hello',
					username: typed.username ? typed.username.value : '',
					password: typed.password ? typed.password.value : '',
					newPassword: typed.fresh ? typed.fresh.value : '',
					fields: {
						username: Boolean(typed.username),
						password: Boolean(typed.password),
						newPassword: Boolean(typed.fresh),
					},
				},
				c.app
			);
			return;
		}
		if (data.step !== 'fill') return;
		removeEventListener('message', hear);
		const now = find();
		put(now.username, data.username);
		put(now.password, data.password);
	};
	addEventListener('message', hear);
};
