import { MESSAGE_MODES } from "./compat.js";

function normalizeTrackerValue(value, defaultMax) {
	const parsedMax = Number(value?.max);
	const max = Math.min(1000, Math.max(0, Math.trunc(Number.isFinite(parsedMax) ? parsedMax : defaultMax)));
	const parsedActual = Number(value?.actual);
	const actual = Math.min(max, Math.max(0, Number.isFinite(parsedActual) ? parsedActual : 0));
	return {max, actual};
}

export class AgeTracker extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
	static DEFAULT_OPTIONS = {
		id: "age-tracker",
		classes: ["age-system", "age-tracker-window"],
		popup: false,
		actions: {
			sermod: AgeTracker._sermod,
			compmod: AgeTracker._compmod,
			milestone: AgeTracker._milestone
		},
		window: {
			frame: false,
			positioned: false
		}
	}

	static PARTS = {
		div: {
			template: "systems/age-system/templates/age-tracker.hbs",
		}
	}

	/** @param {HTMLElement} element  */
	_insertElement(element) {
			const existing = document.getElementById(element.id);
			if (existing) existing.replaceWith(element);
			else (document.getElementById("interface") ?? document.body).append(element);
			this._activatePositionControls(element);
		}

		_activatePositionControls(element) {
			this._applyPosition(element, game.user.getFlag("age-system", "ageTrackerPos") ?? CONFIG.ageSystem.ageTrackerPos);
			const handle = element.querySelector("[data-age-tracker-drag]");
			if (!handle) return;

			handle.addEventListener("contextmenu", this._onRightClick.bind(this));
			handle.addEventListener("pointerdown", event => {
				if (event.button !== 0) return;
				event.preventDefault();
				const rect = element.getBoundingClientRect();
				const start = {x: event.clientX, y: event.clientY, left: rect.left, top: rect.top};
				handle.setPointerCapture?.(event.pointerId);

				const onMove = moveEvent => {
					const left = start.left + moveEvent.clientX - start.x;
					const top = start.top + moveEvent.clientY - start.y;
					const maxLeft = Math.max(8, window.innerWidth - element.offsetWidth - 8);
					const maxTop = Math.max(8, window.innerHeight - element.offsetHeight - 8);
					element.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
					element.style.bottom = `${window.innerHeight - Math.min(Math.max(8, top), maxTop) - element.offsetHeight}px`;
				};
				const onEnd = async endEvent => {
					document.removeEventListener("pointermove", onMove);
					document.removeEventListener("pointerup", onEnd);
					handle.releasePointerCapture?.(endEvent.pointerId);
					await game.user.setFlag("age-system", "ageTrackerPos", {
						xPos: element.style.left,
						yPos: element.style.bottom,
					});
				};
				document.addEventListener("pointermove", onMove);
				document.addEventListener("pointerup", onEnd, {once: true});
			});
		}

		_applyPosition(element, position = CONFIG.ageSystem.ageTrackerPos) {
			element.style.position = "fixed";
			element.style.right = "auto";
			element.style.top = "auto";
			const requestedLeft = position?.xPos === "center"
				? (window.innerWidth - element.offsetWidth) / 2
				: Number.parseFloat(position?.xPos);
			const requestedBottom = Number.parseFloat(position?.yPos);
			const maxLeft = Math.max(8, window.innerWidth - element.offsetWidth - 8);
			const maxBottom = Math.max(8, window.innerHeight - element.offsetHeight - 8);
			const left = Number.isFinite(requestedLeft) ? requestedLeft : (window.innerWidth - element.offsetWidth) / 2;
			const bottom = Number.isFinite(requestedBottom) ? requestedBottom : 88;
			element.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
			element.style.bottom = `${Math.min(Math.max(8, bottom), maxBottom)}px`;
		}

	async _prepareContext(options) {
		const data = await super._prepareContext(options);
		data.isGM = game.user.isGM;
		data.colorset = game.settings.get("age-system", "colorScheme");

		data.hasSerendipity = game.settings.get("age-system", "serendipity");
		if (data.hasSerendipity) {
			const storedSerData = game.settings.get("age-system", "serendipityValue");
			const serData = normalizeTrackerValue(storedSerData, 18);
			if (serData.max !== Number(storedSerData?.max) || serData.actual !== Number(storedSerData?.actual)) {
				await game.settings.set("age-system", "serendipityValue", serData);
			}
			const sides = 6;
			let total = serData.actual
			data.serDie = new Array(Math.ceil(serData.max/sides));
			for (let d = 0; d < data.serDie.length; d++) {
				data.serDie[d] = {};
				data.serDie[d].min = d*sides + 1;
				data.serDie[d].inactive = d*sides < serData.actual ? false : true;
				const diff = total - sides;
				data.serDie[d].value = diff >= 0 ? sides : total < 0 ? 0 : total;
				total = diff;
			}
		}

		const compType = game.settings.get("age-system", "complication");
		data.hasComplication = (compType === "none") ? false : true;
		if (data.hasComplication) {
			const storedCompData = game.settings.get("age-system", "complicationValue");
			const compData = normalizeTrackerValue(storedCompData, 30);
			if (compData.max !== Number(storedCompData?.max) || compData.actual !== Number(storedCompData?.actual)) {
				await game.settings.set("age-system", "complicationValue", compData);
			}
			compData.type = compType;
			compData.tracker = new Array(compData.max);
			for (let b = 0; b < compData.tracker.length; b++) {
				compData.tracker[b] = {};
				compData.tracker[b].check = (compData.actual-1 >= b) ? true : false;
				compData.tracker[b].milestone = ((b+1) % 10 === 0) ? true : false;
			};
			data.compData = compData;
		};
		const system = data;
		return {system};
	}

		refresh() {
			const enabled = game.settings.get("age-system", "serendipity")
				|| game.settings.get("age-system", "complication") !== "none";
			return enabled ? this.render({force: true}) : this.close();
		}

	 	static async _sermod(event, target) {
		event.preventDefault();
			const serData = normalizeTrackerValue(game.settings.get("age-system", "serendipityValue"), 18);
		let value;
		if (event.shiftKey) value = 6;
		if (!value && event.ctrlKey) value = 3;
		if (!value) value = 1;
		if (target.classList.contains('minus')) value = -value;
		serData.actual = Number(serData.actual) + value;
		if (serData.actual > serData.max) serData.actual = serData.max;
		if (serData.actual < 0) serData.actual = 0;
			return game.settings.set("age-system", "serendipityValue", serData);
		}

		async _onRightClick(event) {
			event.preventDefault();
			const tracker = event.currentTarget.closest("#age-tracker");
			const original = CONFIG.ageSystem.ageTrackerPos;
			this._applyPosition(tracker, original);
			return game.user.setFlag("age-system", "ageTrackerPos", {
				xPos: tracker.style.left,
				yPos: tracker.style.bottom,
			});
		}

		static async _compmod(event, target) {
		event.preventDefault();
		const classes = target.classList;
			const compData = normalizeTrackerValue(game.settings.get("age-system", "complicationValue"), 30);
		if (classes.contains('refresh')) return game.settings.set("age-system", "complicationValue", {max: compData.max, actual: 0});
		let value;
		if (event.shiftKey) value = 10;
		if (!value && event.ctrlKey) value = 5;
		if (!value) value = 1;
		if (classes.contains('minus')) value = -value;
		compData.actual = Number(compData.actual) + value;
		if (compData.actual > compData.max) compData.actual = compData.max;
		if (compData.actual < 0) compData.actual = 0;
			return game.settings.set("age-system", "complicationValue", compData);
	}

	static _milestone() {
		const rollTable = game.settings.get("age-system", "complicationRollTable");
		if (rollTable === "none") return AgeTracker._defaultRoll();
		const table = game.tables.get(rollTable);
		return table ? table.draw() : AgeTracker._defaultRoll();
	}

		static async _defaultRoll() {
		const compType = game.i18n.localize(`SETTINGS.comp${game.settings.get("age-system", "complication")}`);
		const flavor = game.i18n.format("age-system.chatCard.compRoll", {compType});
			const compRoll = await new Roll("1d6").evaluate();
			return compRoll.toMessage({flavor}, {messageMode: MESSAGE_MODES.SELF});
	}
}
