import { sortObjArrayByName } from "./setup.js";
import { ageSystem } from "./config.js";
import {
  CLASS_MAX_LEVEL,
  ClassAdvancementService,
  normalizeClassSystem,
  normalizeItemAdvancement,
  normalizeProgressiveAdvancement,
} from "./class-advancement.js";

const AppV1 = foundry.appv1.api;
const getDragData = event => foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
const resolveSync = uuid => foundry.utils.fromUuidSync?.(uuid) ?? globalThis.fromUuidSync?.(uuid);
const clone = value => foundry.utils.deepClone(value);

function asArray(value, length = 0) {
  let array;
  if (Array.isArray(value)) array = value;
  else if (value && typeof value === "object") array = Object.keys(value).sort((a, b) => Number(a) - Number(b)).map(key => value[key]);
  else if (value === undefined || value === null) array = [];
  else array = [value];
  if (length) return Array.from({length}, (_, index) => array[index] ?? 0);
  return array;
}

function formArray(formData, key, length = 0) {
  if (formData?.[key] !== undefined) return asArray(formData[key], length);
  const indexed = Object.entries(formData ?? {})
    .map(([field, value]) => {
      const match = field.match(new RegExp(`^${key}\\.(\\d+)$`));
      return match ? [Number(match[1]), value] : null;
    })
    .filter(Boolean)
    .sort((left, right) => left[0] - right[0]);
  return asArray(Object.fromEntries(indexed), length);
}

function advancementTraits(type) {
  const traits = ageSystem.advData.stances.type[type] ?? [];
  return sortObjArrayByName(traits.map(key => {
    let name;
    if (key === "health") name = ageSystem.healthSys.healthName;
    else if (key === "powerPoints") name = ageSystem.POWER_FLAVOR.points;
    else if (key === "spec") name = game.i18n.localize("age-system.item.spec");
    else name = game.i18n.localize(`age-system.${key}`);
    return {key, name};
  }), "name");
}

export class AdvancementAdd extends AppV1.Application {
  constructor(classUuid, options = {}) {
    super(options);
    this.classUuid = classUuid;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["age-system-dialog", "age-system", "advancement-config"],
      template: "systems/age-system/templates/advancement-add.hbs",
      resizable: false,
      minimizable: false,
      width: 400,
      height: "auto",
    });
  }

  get classItem() { return resolveSync(this.classUuid); }
  get title() { return `${game.i18n.localize("TYPES.Item.class")}: ${this.classItem?.name ?? ""}`; }

  getData() {
    return {config: ageSystem, class: this.classItem, system: this.classItem?.system};
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".options").click(event => {
      const type = event.currentTarget.dataset.adv;
      if (!type) return;
      new AdvancementSetup(this.classUuid, type).render(true);
      this.close();
    });
  }
}

class AdvData {
  constructor(type, options = {}) {
    this.advType = type;
    this.traitArr = advancementTraits(type);
    this.traitArrTypes = this.traitArr.map(entry => entry.key);
    this.isEdit = Boolean(options.data);
    this.index = options.index ?? null;

    if (type === "progressive") {
      const normalized = normalizeProgressiveAdvancement(options.data ?? {
        trait: this.traitArr[0]?.key ?? "health",
        alias: "",
        img: ageSystem.advData.icon.progressive,
        values: ageSystem.advData.stances[this.traitArr[0]?.key] ?? new Array(CLASS_MAX_LEVEL).fill(0),
      });
      Object.assign(this, normalized);
      this.adv = normalized.values;
    } else {
      const normalized = normalizeItemAdvancement(options.data ?? {
        level: 1,
        alias: "",
        img: ageSystem.advData.icon.item,
        selectionMode: "all",
        quantity: 1,
        allowProgression: true,
        grants: [],
      });
      Object.assign(this, normalized);
      this.itemOption = normalized.selectionMode === "choose" ? "multiple" : "all";
      this.itemQtd = normalized.quantity;
      this.itemArr = normalized.grants.map(grant => ({...grant}));
      this.tType = this.traitArr.find(entry => ["focus", "talent", "spec", "relationship"].includes(entry.key))?.key ?? "focus";
    }
  }
}

export class AdvancementSetup extends AppV1.FormApplication {
  constructor(classUuid, advType, options = {}) {
    super(options);
    this.classUuid = classUuid;
    this.classItem = resolveSync(classUuid);
    this.advData = new AdvData(advType, options);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      dragDrop: [{dropSelector: ".item-drop-area"}],
      classes: ["age-system-dialog", "age-system", "advancement-config"],
      template: "systems/age-system/templates/advancement-setup.hbs",
      resizable: true,
      minimizable: false,
      width: 620,
      height: "auto",
      closeOnSubmit: true,
    });
  }

  get title() { return `${game.i18n.localize("TYPES.Item.class")}: ${this.classItem?.name ?? ""}`; }

  getData() {
    const itemArrSize = Math.max(1, this.advData.itemArr?.length ?? 1);
    return {
      config: ageSystem,
      class: this.classItem,
      ...this.advData,
      levels: Array.from({length: CLASS_MAX_LEVEL}, (_, index) => index + 1),
      itemArrSize,
      itemOptionObj: {
        all: game.i18n.localize("age-system.itemOptionAll"),
        multiple: game.i18n.localize("age-system.itemOptionMultiple"),
      },
      progressionTraits: this.advData.traitArr.filter(entry => ["focus", "talent", "spec", "relationship"].includes(entry.key)),
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("button.cancel").click(() => this.close());
    html.find(".item-delete").click(event => {
      const index = Number(event.currentTarget.dataset.index);
      this.advData.itemArr.splice(index, 1);
      this.render(false);
    });
    html.find(".options-column input, .options-column select").change(event => {
      const element = event.currentTarget;
      const value = element.type === "checkbox" ? element.checked : element.value;
      this.advData[element.name] = value;
      if (element.name === "itemOption") this.advData.selectionMode = value === "multiple" ? "choose" : "all";
      this.render(false);
    });
    html.find("button.addItemProg").click(() => this._addProgressionPlaceholder());
  }

  async _onDrop(event) {
    if (!this.isEditable || this.advData.advType !== "item") return false;
    const dragData = getDragData(event);
    const item = dragData.uuid ? await foundry.utils.fromUuid(dragData.uuid) : null;
    if (!item || item.documentName !== "Item") return false;
    const trait = item.type === "talent" && item.system.type === "spec" ? "spec" : item.type;
    if (!this.advData.traitArrTypes.includes(trait)) {
      ui.notifications.warn(game.i18n.localize("age-system.WARNING.invalidClassGrant"));
      return false;
    }
    if (this.advData.itemArr.some(entry => entry.uuid === item.uuid)) {
      ui.notifications.warn(game.i18n.localize("age-system.WARNING.duplicateClassGrant"));
      return false;
    }
    this.advData.itemArr.push({
      id: foundry.utils.randomID(20),
      type: item.type,
      trait,
      uuid: item.uuid,
      name: item.name,
      img: item.img,
      isItemProg: false,
    });
    this.render(false);
    return true;
  }

  _addProgressionPlaceholder() {
    const trait = this.advData.tType;
    if (!["focus", "talent", "spec", "relationship"].includes(trait)) return;
    this.advData.itemArr.push({
      id: foundry.utils.randomID(20),
      trait,
      type: trait === "spec" ? "talent" : trait,
      uuid: null,
      name: game.i18n.localize("age-system.itemProgression"),
      img: ageSystem.advData.icon.item,
      isItemProg: true,
    });
    this.render(false);
  }

  async _updateObject(_event, formData) {
    if (!this.classItem || this.classItem.isOwned) throw new Error(game.i18n.localize("age-system.WARNING.ownedClassDefinitionLocked"));
    const normalizedClass = normalizeClassSystem(this.classItem.system);
    const type = this.advData.advType;

    if (type === "progressive") {
      const values = formArray(formData, "adv", CLASS_MAX_LEVEL);
      if (!values.some(value => !["", 0, "0", null, undefined].includes(value))) {
        ui.notifications.warn(game.i18n.localize("age-system.WARNING.emptyAdv"));
        return;
      }
      const entry = normalizeProgressiveAdvancement({
        id: this.advData.id,
        trait: formData.trait ?? this.advData.trait,
        alias: formData.alias || this.advData.alias || game.i18n.localize(`age-system.${formData.trait ?? this.advData.trait}`),
        img: formData.img || this.advData.img || ageSystem.advData.icon.progressive,
        values,
      });
      const array = normalizedClass.advancements.progressive;
      if (this.advData.isEdit) array[this.advData.index.id] = entry;
      else array.push(entry);
      await this.classItem.update({"system.advancements.progressive": array});
      return;
    }

    if (!this.advData.itemArr.length) {
      ui.notifications.warn(game.i18n.localize("age-system.WARNING.emptyItemArr"));
      return;
    }
    const selectionMode = (formData.itemOption ?? this.advData.itemOption) === "multiple" ? "choose" : "all";
    const requestedQuantity = Number(formData.itemQtd ?? this.advData.itemQtd ?? 1);
    const quantity = selectionMode === "choose" ? Math.max(1, Math.min(requestedQuantity, this.advData.itemArr.length)) : this.advData.itemArr.length;
    const entry = normalizeItemAdvancement({
      id: this.advData.id,
      level: Number(formData.level ?? this.advData.level),
      alias: formData.alias || this.advData.alias || game.i18n.localize("age-system.advNewItem"),
      img: formData.img || this.advData.img || ageSystem.advData.icon.item,
      selectionMode,
      quantity,
      allowProgression: Boolean(this.advData.allowProgression),
      grants: this.advData.itemArr,
    });
    const array = normalizedClass.advancements.item;
    if (this.advData.isEdit) array[this.advData.index.id] = entry;
    else array.push(entry);
    await this.classItem.update({"system.advancements.item": array});
  }
}

export class AgeLevel {
  constructor(actor, classItem, targetLevel, draft) {
    this.actor = actor;
    this.classItem = classItem;
    this.targetLevel = targetLevel;
    this.draft = draft;
  }

  static async create(actor, classItem, targetLevel, options = {}) {
    const draft = await ClassAdvancementService.createDraft(actor, classItem, targetLevel, options);
    return new this(actor, classItem, targetLevel, draft);
  }

  validate(choices = this.draft.choices) { return ClassAdvancementService.validateChoices(this.draft, choices); }
  apply(choices = this.draft.choices, options = {}) { return ClassAdvancementService.applyLevel(this.actor, this.classItem, choices, {...options, draft: this.draft}); }
}

export class AgeProgUI extends AppV1.FormApplication {
  constructor(ageLevel, options = {}) {
    super(ageLevel, options);
    this.newLevel = ageLevel;
    this.draft = ageLevel.draft;
    this.choices = clone(this.draft.choices);
  }

  static async open(actor, classItem, options = {}) {
    const ageLevel = await AgeLevel.create(actor, classItem, Number(classItem.system.level) + 1, options);
    return new this(ageLevel).render(true);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["age-system-dialog", "age-system", "advancement-config", "class-level-dialog"],
      template: "systems/age-system/templates/advancement-level-pick-choice.hbs",
      resizable: true,
      minimizable: false,
      width: 760,
      height: 760,
      closeOnSubmit: false,
    });
  }

  get title() {
    return game.i18n.format("age-system.CLASS.levelTitle", {name: this.draft.classItem.name, level: this.draft.targetLevel});
  }

  getData() {
    const abilityAllocations = this.choices.ability;
    const spent = Object.values(abilityAllocations).reduce((sum, value) => sum + Number(value || 0), 0);
    const validation = ClassAdvancementService.validateChoices(this.draft, this.choices);
    return {
      actor: this.draft.actor,
      classItem: this.draft.classItem,
      targetLevel: this.draft.targetLevel,
      ability: {
        ...this.draft.ability,
        spent,
        remaining: this.draft.ability.points - spent,
        options: this.draft.ability.options.map(option => ({...option, allocation: Number(abilityAllocations[option.key]) || 0})),
      },
      formulas: this.draft.formulas.map(formula => ({...formula, result: this.choices.formulaResults[formula.key]})),
      itemGroups: this.draft.itemGroups.map(group => ({
        ...group,
        grants: group.grants.map(grant => ({
          ...grant,
          selected: group.selectionMode === "all" || (this.choices.itemSelections[group.key] ?? []).includes(grant.key),
          progressionTarget: this.choices.progressionTargets[grant.key] ?? "",
        })),
      })),
      warnings: this.draft.warnings,
      validation,
      canSubmit: validation.valid,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("button.cancel").click(() => this.close());
    html.find(".ability-change").click(event => this._changeAbility(event));
    html.find(".formula-result").change(event => {
      this.choices.formulaResults[event.currentTarget.dataset.key] = Number(event.currentTarget.value);
      this.render(false);
    });
    html.find(".reroll-formula").click(event => this._rerollFormula(event));
    html.find(".grant-select").change(event => this._toggleGrant(event));
    html.find(".progression-target").change(event => {
      this.choices.progressionTargets[event.currentTarget.dataset.grantKey] = event.currentTarget.value;
      this.render(false);
    });
  }

  _changeAbility(event) {
    const key = event.currentTarget.dataset.key;
    const delta = Number(event.currentTarget.dataset.delta);
    const current = Number(this.choices.ability[key]) || 0;
    const spent = Object.values(this.choices.ability).reduce((sum, value) => sum + Number(value || 0), 0);
    if (delta > 0 && spent >= this.draft.ability.points) return;
    if (delta < 0 && current <= 0) return;
    this.choices.ability[key] = current + delta;
    this.render(false);
  }

  async _rerollFormula(event) {
    const key = event.currentTarget.dataset.key;
    const formula = this.draft.formulas.find(entry => entry.key === key);
    if (!formula) return;
    const rollData = typeof this.draft.actor.actorRollData === "function" ? this.draft.actor.actorRollData() : {};
    const roll = await new Roll(formula.formula, rollData).evaluate();
    this.choices.formulaResults[key] = roll.total;
    await roll.toMessage({flavor: formula.alias});
    this.render(false);
  }

  _toggleGrant(event) {
    const groupKey = event.currentTarget.dataset.groupKey;
    const grantKey = event.currentTarget.dataset.grantKey;
    const group = this.draft.itemGroups.find(entry => entry.key === groupKey);
    const selected = new Set(this.choices.itemSelections[groupKey] ?? []);
    if (event.currentTarget.checked) {
      if (group.selectionMode === "choose" && selected.size >= group.quantity) {
        event.currentTarget.checked = false;
        ui.notifications.warn(game.i18n.format("age-system.WARNING.classGrantLimit", {quantity: group.quantity}));
        return;
      }
      selected.add(grantKey);
    } else selected.delete(grantKey);
    this.choices.itemSelections[groupKey] = [...selected];
    this.render(false);
  }

  async _updateObject() {
    const validation = ClassAdvancementService.validateChoices(this.draft, this.choices);
    if (!validation.valid) {
      ui.notifications.error(validation.errors.join("\n"));
      return;
    }
    try {
      await this.newLevel.apply(this.choices);
      ui.notifications.info(game.i18n.format("age-system.CLASS.levelApplied", {name: this.draft.classItem.name, level: this.draft.targetLevel}));
      await this.close();
    } catch (error) {
      console.error("AGE System | Class level-up failed", error);
      ui.notifications.error(error.message);
    }
  }
}
