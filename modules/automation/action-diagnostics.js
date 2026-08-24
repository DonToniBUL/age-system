import {AgeTransactionService} from "./action-transactions.js";
import {AgeActionService} from "./actions.js";
import {AgeContentValidator} from "./content-validator.js";
import {AgeMigrationPreview} from "../data/migration-preview.js";

function time(value) {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "—";
}

function diagnosticRow(entry) {
  return {
    id: entry.id,
    type: entry.type,
    status: entry.status,
    time: time(entry.finishedAt ?? entry.startedAt),
    duration: Number(entry.durationMs ?? 0),
    targets: entry.targetUuids?.length ?? 0,
    error: entry.error?.message ?? null
  };
}

function transactionRow(entry) {
  return {
    id: entry.id,
    label: entry.label,
    type: entry.type,
    time: time(entry.timestamp),
    operations: entry.operations?.length ?? 0,
    undone: entry.undone === true
  };
}

async function confirmation() {
  return foundry.applications.api.DialogV2.confirm({
    window: {title: game.i18n.localize("age-system.AUTOMATION.clearActionDiagnostics")},
    content: `<p>${game.i18n.localize("age-system.AUTOMATION.clearActionDiagnosticsHint")}</p>`,
    rejectClose: false,
    yes: {label: game.i18n.localize("age-system.confirm"), icon: "fa-solid fa-trash"},
    no: {label: game.i18n.localize("age-system.cancel"), icon: "fa-solid fa-xmark", default: true}
  });
}

export class AgeActionDiagnostics {
  static async data({audit = null, migration = null} = {}) {
    const [diagnostics, transactions] = await Promise.all([
      AgeActionService.history(),
      AgeTransactionService.history()
    ]);
    const status = AgeActionService.status();
    return {
      systemVersion: game.system?.version ?? "—",
      apiVersion: game.ageSystem?.api?.apiVersion ?? "—",
      schemaVersion: status.schemaVersion,
      registeredActions: status.registeredActions,
      registeredTemplates: status.registeredTemplates,
      pending: status.pendingIds.length,
      diagnostics: diagnostics.slice(-25).reverse().map(diagnosticRow),
      transactions: transactions.slice(-10).reverse().map(transactionRow),
      audit: audit ? {
        valid: audit.valid === true,
        documents: audit.documentCount ?? 0,
        errors: audit.errorCount ?? audit.errors?.length ?? 0,
        warnings: audit.warningCount ?? audit.warnings?.length ?? 0,
        issues: (audit.issues ?? []).slice(0, 20)
      } : null,
      migration: migration ? {
        valid: migration.valid === true,
        documents: migration.documentCount ?? 0,
        changes: migration.changeCount ?? 0,
        reviews: migration.reviewCount ?? 0,
        blockers: migration.blockerCount ?? 0,
        operations: (migration.operations ?? []).slice(0, 30)
      } : null
    };
  }

  static async export({audit = null, migration = null} = {}) {
    const payload = {
      exportedAt: new Date().toISOString(),
      system: {id: game.system?.id ?? "age-system", version: game.system?.version ?? null},
      api: {version: game.ageSystem?.api?.apiVersion ?? null, actionStatus: AgeActionService.status()},
      definitions: AgeActionService.definitions(),
      templates: AgeActionService.templates(),
      diagnostics: await AgeActionService.history(),
      transactions: await AgeTransactionService.history(),
      contentAudit: audit,
      migrationPreview: migration
    };
    foundry.utils.saveDataToFile(
      JSON.stringify(payload, null, 2),
      "application/json",
      `age-system-${game.system?.version ?? "diagnostics"}-operations.json`
    );
    return payload;
  }

  static async open({audit = null, migration = null} = {}) {
    const data = await this.data({audit, migration});
    const content = await foundry.applications.handlebars.renderTemplate(
      "systems/age-system/templates/automation/action-diagnostics.hbs",
      data
    );
    const result = await foundry.applications.api.DialogV2.wait({
      window: {title: game.i18n.localize("age-system.AUTOMATION.actionDiagnostics")},
      position: {width: 760, height: "auto"},
      content,
      modal: false,
      rejectClose: false,
      buttons: [
        {
          action: "audit",
          label: game.i18n.localize("age-system.AUTOMATION.runContentAudit"),
          icon: "fa-solid fa-magnifying-glass-chart",
          callback: () => "audit"
        },
        {
          action: "migration",
          label: game.i18n.localize("age-system.AUTOMATION.previewMigration"),
          icon: "fa-solid fa-code-compare",
          callback: () => "migration"
        },
        {
          action: "export",
          label: game.i18n.localize("age-system.AUTOMATION.exportDiagnostics"),
          icon: "fa-solid fa-file-export",
          callback: () => "export"
        },
        {
          action: "clear",
          label: game.i18n.localize("age-system.AUTOMATION.clearActionDiagnostics"),
          icon: "fa-solid fa-trash",
          callback: () => "clear"
        },
        {
          action: "close",
          label: game.i18n.localize("age-system.AUTOMATION.close"),
          icon: "fa-solid fa-xmark",
          default: true,
          callback: () => "close"
        }
      ]
    });

    if (result === "audit") {
      ui.notifications.info(game.i18n.localize("age-system.AUTOMATION.contentAuditRunning"));
      const report = await AgeContentValidator.validateWorld({includePacks: true});
      return this.open({audit: report, migration});
    }
    if (result === "migration") {
      ui.notifications.info(game.i18n.localize("age-system.AUTOMATION.migrationPreviewRunning"));
      const report = await AgeMigrationPreview.previewWorld({includePacks: true});
      return this.open({audit, migration: report});
    }
    if (result === "export") {
      await this.export({audit, migration});
      return this.open({audit, migration});
    }
    if (result === "clear" && await confirmation()) {
      await AgeActionService.clearHistory();
      return this.open({audit, migration});
    }
    return result;
  }
}

export default AgeActionDiagnostics;
