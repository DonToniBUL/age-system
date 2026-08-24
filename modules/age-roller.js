import { ageSystem } from "./config.js";
import { ageRollCheck } from "./dice.js";
import ConditionsWorkshop from "./conditions-workshop.js";
import { applyBreather } from "./breather.js";
import AgeImporter from "./age-importer.js";
import r20importer from "./r20importer.js";
import { getCoreMessageMode, MESSAGE_MODES } from "./compat.js";
import { showFileImportDialog } from "./dialogs.js";

export class AgeRoller extends foundry.appv1.api.Application {
	constructor(options = {}) {
		super(options)
		this._r20data = null;
	}

	get template() {
		return `systems/age-system/templates/rolls/age-roller.hbs`;
	}
	
	getData(options) {
		const data = super.getData(options);
		data.colorset = game.settings.get("age-system", "colorScheme");
		data.isGM = game.user.isGM;
		data.wikiLink = ageSystem.wiki;

		data.language = game.settings.get("core", "language");
		data.reqLang = true;
		return data;
	}
	
	activateListeners(html) {
		super.activateListeners(html);
		html.find('li').hover(t => t.currentTarget.classList.toggle('colorset-third-tier'));
		html.find("#age-roller i").click(this._onClick.bind(this));
		html.find("#age-roller i").contextmenu(this._onRightClick.bind(this));
		html.find("#age-roller-drag").contextmenu(this._onResetPosition.bind(this));
		html.find(".conditions-workshop").click(this.openConditionWorkshop.bind(this));
		html.find(".age-importer").click(this.openAgeImporter.bind(this));
		html.find(".r20-importer").click(this.startR20Importer.bind(this));
		html.find(".breather-tokens").click(this.tokenBreather);
		html.find('.roll').click(this._onSpecialRoll.bind(this));
		html.find('.roll').contextmenu(this._onSpecialRoll.bind(this));
		html.find("#age-roller-container").hover(this._onToggleOptions.bind(this));
		html.find('#age-roller-options').click(this._onToggleOptions.bind(this));

		// Set position
		let roller = document.getElementById("age-roller");
		const rollerPos = game.user.getFlag("age-system", "ageRollerPos") ?? CONFIG.ageSystem.ageRollerPos;
		roller.style.left = rollerPos.xPos;
		roller.style.bottom = rollerPos.yPos;
		
		// Make the DIV element draggable:
		this._dragElement(roller);
	}
	
	refresh() {
		this.render(true);
	}

	async _onSpecialRoll(ev) {
		ev.preventDefault();
		const type = ev.currentTarget.dataset.roll;
		let formula = "";
		if (type === 'd666') formula += '1d6*100 + '
		formula += '1d6*10 + 1d6'
		let roll = await new Roll(formula).evaluate();
		return roll.toMessage({flavor: type}, {messageMode: (ev.shiftKey || ev.type === "contextmenu") ? MESSAGE_MODES.SELF : getCoreMessageMode()});
	}

	tokenBreather(ev) {
		return applyBreather(MESSAGE_MODES.SELF);
	}

	openConditionWorkshop(ev) {
		return new ConditionsWorkshop().render(true);
	}

	openAgeImporter(ev) {
		return new AgeImporter().render(true);
	}

	startR20Importer(ev) {
		return this._onReadFromFile();
	}

	async _onReadFromFile() {
		const content = await foundry.applications.handlebars.renderTemplate("templates/apps/import-data.html", {
			hint1: game.i18n.format("DOCUMENT.ImportDataHint1", {document: "R20 Importer"})
		});
		return showFileImportDialog({
			title: "AGE R20 Import",
			content,
			onImport: json => this.importFromJSON(json),
		});
	};

	/**
	 * Read a JSON from a file with R20 Importer data, validate and save it.
	 * @param {string} json Stringfied JSON object
	 */
	importFromJSON(json){
		let data;
		try {
			data = JSON.parse(json);
		}
		catch(err) {
			console.log(err.message)
			return ui.notifications.warn(game.i18n.localize("age-system.invalidFileContent"));
		}
		return new r20importer(data);
	}
	
	_onToggleOptions(ev) {
		ev.preventDefault();
		const opt = document.getElementById("age-roller-options");
		const view = opt.style.display;
		switch (view) {
			case '':
			case 'none':
				opt.style.display = 'inline-block';
				break;
			case 'inline-block':
				opt.style.display = 'none';
				break;
			default:
				break;
		}
	}

 	async _onClick(event) {
		event.preventDefault();
		const rollData = {
			event,
			flavor: game.user.name,
			flavor2: game.i18n.localize("age-system.chatCard.looseRoll")
		}
		return ageRollCheck(rollData);
	}

	async _onRightClick(event) {
		event.preventDefault();
		let roll = await new Roll("1d6").evaluate();
		return roll.toMessage({}, {messageMode: event.shiftKey ? MESSAGE_MODES.BLIND : getCoreMessageMode()});
	}

	async _onResetPosition(event) {
		const elmnt = event.currentTarget.closest("#age-roller");
		const original = CONFIG.ageSystem.ageRollerPos;
		elmnt.style.left = original.xPos;
		elmnt.style.bottom = original.yPos;
		this._setOptionsMenuPos(elmnt);
		return game.user.setFlag("age-system", "ageRollerPos", original);
	}

	_setOptionsMenuPos(ref) {
		let opts = document.getElementById("age-roller-options");
		opts.style.left = (ref.offsetLeft + 52) + "px";
		opts.style.bottom = (ref.offsetParent.clientHeight - ref.offsetTop - ref.clientHeight) + "px";
	}

	_dragElement(elmnt) {
		var pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
		const ageRoller = this;
		if (document.getElementById("age-roller-drag")) {
			// if present, the header is where you move the DIV from:
			document.getElementById("age-roller-drag").onmousedown = dragMouseDown;
		} else {
			// otherwise, move the DIV from anywhere inside the DIV:
			elmnt.onmousedown = dragMouseDown;
		}

		// Set new position for Options Menu
		this._setOptionsMenuPos(elmnt)
	  
		function dragMouseDown(e) {
			e = e || window.event;
			e.preventDefault();
			// get the mouse cursor position at startup:
			pos3 = e.clientX;
			pos4 = e.clientY;
			document.onmouseup = closeDragElement;
			// call a function whenever the cursor moves:
			document.onmousemove = elementDrag;
		}
	  
		function elementDrag(e) {
			e = e || window.event;
			e.preventDefault();
			// calculate the new cursor position:
			pos1 = pos3 - e.clientX;
			pos2 = pos4 - e.clientY;
			pos3 = e.clientX;
			pos4 = e.clientY;
			// set the element's new position:
			elmnt.style.bottom = (elmnt.offsetParent.clientHeight - elmnt.offsetTop - elmnt.clientHeight + pos2) + "px";
			elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
		}
	  
		function closeDragElement() {
		  	// stop moving when mouse button is released:
		  	document.onmouseup = null;
		  	document.onmousemove = null;
		  	// Save position on appropriate User Flag
			const rollerPos = {};
			rollerPos.xPos = elmnt.style.left;
			rollerPos.yPos = elmnt.style.bottom;
			game.user.setFlag("age-system", "ageRollerPos", rollerPos);
			ageRoller._setOptionsMenuPos(elmnt)
		}
	}
}
