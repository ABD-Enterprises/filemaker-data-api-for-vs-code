import * as vscode from 'vscode';

import type { ProfileStore } from '../services/profileStore';
import type { SchemaService } from '../services/schemaService';
import {
  buildLayoutInspectorModel,
  type LayoutInspectorField,
  type LayoutInspectorModel,
  type LayoutInspectorPortal,
  type LayoutInspectorValidationRule
} from '../utils/layoutInspector';

type LayoutInspectorNodeKind =
  | 'category'
  | 'field'
  | 'portal'
  | 'portalField'
  | 'valueList'
  | 'validation'
  | 'placeholder';

type LayoutInspectorCategory = 'fields' | 'portals' | 'valueLists' | 'validations';

interface LayoutInspectorSelection {
  profileId: string;
  layoutName: string;
}

class LayoutInspectorItem extends vscode.TreeItem {
  public readonly kind: LayoutInspectorNodeKind;
  public readonly category?: LayoutInspectorCategory;
  public readonly portalKey?: string;

  public constructor(options: {
    kind: LayoutInspectorNodeKind;
    label: string;
    collapsibleState?: vscode.TreeItemCollapsibleState;
    category?: LayoutInspectorCategory;
    portalKey?: string;
    description?: string;
    tooltip?: string;
    iconPath?: vscode.ThemeIcon;
    contextValue?: string;
  }) {
    super(options.label, options.collapsibleState ?? vscode.TreeItemCollapsibleState.None);

    this.kind = options.kind;
    this.category = options.category;
    this.portalKey = options.portalKey;
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.iconPath = options.iconPath;
    this.contextValue = options.contextValue;
  }
}

interface LayoutInspectorCacheEntry {
  profileName: string;
  database: string;
  model: LayoutInspectorModel;
}

export class LayoutInspectorProvider implements vscode.TreeDataProvider<LayoutInspectorItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    LayoutInspectorItem | undefined
  >();
  private readonly cache = new Map<string, LayoutInspectorCacheEntry>();
  private selection: LayoutInspectorSelection | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly profileStore: ProfileStore,
    private readonly schemaService: SchemaService
  ) {}

  public selectLayout(profileId: string, layoutName: string): void {
    this.selection = { profileId, layoutName };
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public clearProfile(profileId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${profileId}:`)) {
        this.cache.delete(key);
      }
    }

    if (this.selection?.profileId === profileId) {
      this.selection = undefined;
      this.onDidChangeTreeDataEmitter.fire(undefined);
    }
  }

  public async refreshCurrent(): Promise<void> {
    if (!this.selection) {
      this.onDidChangeTreeDataEmitter.fire(undefined);
      return;
    }

    const profile = await this.profileStore.getProfile(this.selection.profileId);
    if (profile) {
      this.schemaService.invalidateLayout(profile, this.selection.layoutName);
    }

    this.cache.delete(this.cacheKey(this.selection.profileId, this.selection.layoutName));
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: LayoutInspectorItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: LayoutInspectorItem): Promise<LayoutInspectorItem[]> {
    if (!this.selection) {
      return [];
    }

    const entry = await this.getModel();
    if (!entry) {
      return [
        new LayoutInspectorItem({
          kind: 'placeholder',
          label: 'Layout metadata unavailable',
          description: 'Refresh or select another layout.',
          iconPath: new vscode.ThemeIcon('warning')
        })
      ];
    }

    if (!element) {
      return this.getCategoryItems(entry.model, entry.profileName, entry.database);
    }

    if (element.kind !== 'category' || !element.category) {
      if (element.kind === 'portal' && element.portalKey) {
        return this.getPortalFieldItems(entry.model, element.portalKey);
      }

      return [];
    }

    switch (element.category) {
      case 'fields':
        return entry.model.fields.map((field) => toFieldItem(field));
      case 'portals':
        return entry.model.portals.length > 0
          ? entry.model.portals.map((portal) => toPortalItem(portal))
          : [emptyItem('No portals on this layout')];
      case 'valueLists':
        return entry.model.valueLists.length > 0
          ? entry.model.valueLists.map(
              (valueList) =>
                new LayoutInspectorItem({
                  kind: 'valueList',
                  label: valueList.name,
                  description: `${valueList.values.length} item${valueList.values.length === 1 ? '' : 's'}`,
                  tooltip: valueList.values
                    .slice(0, 25)
                    .map((item) =>
                      item.displayValue === item.value
                        ? item.value
                        : `${item.value} -> ${item.displayValue}`
                    )
                    .join('\n'),
                  iconPath: new vscode.ThemeIcon('list-unordered'),
                  contextValue: 'fmLayoutInspectorValueList'
                })
            )
          : [emptyItem('No value lists on this layout')];
      case 'validations':
        return entry.model.validations.length > 0
          ? entry.model.validations.map((validation) => toValidationItem(validation))
          : [emptyItem('No field validation rules')];
    }
  }

  private getCategoryItems(
    model: LayoutInspectorModel,
    profileName: string,
    database: string
  ): LayoutInspectorItem[] {
    const layoutName = this.selection?.layoutName ?? '';
    const tooltip = [
      `Profile: ${profileName}`,
      `Database: ${database}`,
      `Layout: ${layoutName}`
    ].join('\n');

    return [
      new LayoutInspectorItem({
        kind: 'category',
        category: 'fields',
        label: 'Fields',
        description: `${model.fields.length}`,
        tooltip,
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        iconPath: new vscode.ThemeIcon('symbol-field'),
        contextValue: 'fmLayoutInspectorCategory'
      }),
      new LayoutInspectorItem({
        kind: 'category',
        category: 'portals',
        label: 'Portals',
        description: `${model.portals.length}`,
        tooltip,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        iconPath: new vscode.ThemeIcon('symbol-namespace'),
        contextValue: 'fmLayoutInspectorCategory'
      }),
      new LayoutInspectorItem({
        kind: 'category',
        category: 'valueLists',
        label: 'Value Lists',
        description: `${model.valueLists.length}`,
        tooltip,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        iconPath: new vscode.ThemeIcon('list-unordered'),
        contextValue: 'fmLayoutInspectorCategory'
      }),
      new LayoutInspectorItem({
        kind: 'category',
        category: 'validations',
        label: 'Field Validation',
        description: `${model.validations.length}`,
        tooltip,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        iconPath: new vscode.ThemeIcon('shield'),
        contextValue: 'fmLayoutInspectorCategory'
      })
    ];
  }

  private async getModel(): Promise<LayoutInspectorCacheEntry | undefined> {
    if (!this.selection) {
      return undefined;
    }

    const cacheKey = this.cacheKey(this.selection.profileId, this.selection.layoutName);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const profile = await this.profileStore.getProfile(this.selection.profileId);
    if (!profile) {
      return undefined;
    }

    const schema = await this.schemaService.getLayoutSchema(profile, this.selection.layoutName);
    if (!schema.supported) {
      return undefined;
    }

    const entry = {
      profileName: profile.name,
      database: profile.database,
      model: buildLayoutInspectorModel(schema)
    };

    this.cache.set(cacheKey, entry);
    return entry;
  }

  private getPortalFieldItems(
    model: LayoutInspectorModel,
    portalKey: string
  ): LayoutInspectorItem[] {
    const portal = model.portals.find((item) => item.key === portalKey);
    if (!portal) {
      return [];
    }

    return portal.fields.map(
      (field) =>
        new LayoutInspectorItem({
          kind: 'portalField',
          label: field.name,
          description: field.type,
          tooltip: [
            `Portal: ${portal.key}`,
            `Related table: ${portal.relatedTable}`,
            `Field: ${field.name}`
          ]
            .filter(Boolean)
            .join('\n'),
          iconPath: new vscode.ThemeIcon('symbol-field'),
          contextValue: 'fmLayoutInspectorPortalField'
        })
    );
  }

  private cacheKey(profileId: string, layoutName: string): string {
    return `${profileId}:${layoutName}`;
  }
}

function toFieldItem(field: LayoutInspectorField): LayoutInspectorItem {
  const descriptionParts = [field.type, field.isGlobal ? 'global' : undefined].filter(
    (value): value is string => Boolean(value)
  );

  if (typeof field.repetitions === 'number') {
    descriptionParts.push(`x${field.repetitions}`);
  }

  return new LayoutInspectorItem({
    kind: 'field',
    label: field.name,
    description: descriptionParts.join(' • ') || undefined,
    tooltip: [
      `Field: ${field.name}`,
      field.type ? `Type: ${field.type}` : undefined,
      field.isGlobal ? 'Global storage' : undefined,
      typeof field.repetitions === 'number' ? `Repetitions: ${field.repetitions}` : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
    iconPath: new vscode.ThemeIcon(field.isGlobal ? 'globe' : 'symbol-field'),
    contextValue: 'fmLayoutInspectorField'
  });
}

function toPortalItem(portal: LayoutInspectorPortal): LayoutInspectorItem {
  return new LayoutInspectorItem({
    kind: 'portal',
    label: portal.key,
    portalKey: portal.key,
    description: portal.relatedTable,
    tooltip: [
      `Portal key: ${portal.key}`,
      `Related table: ${portal.relatedTable}`,
      `${portal.fields.length} fields`
    ].join('\n'),
    collapsibleState:
      portal.fields.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    iconPath: new vscode.ThemeIcon('symbol-namespace'),
    contextValue: 'fmLayoutInspectorPortal'
  });
}

function toValidationItem(validation: LayoutInspectorValidationRule): LayoutInspectorItem {
  return new LayoutInspectorItem({
    kind: 'validation',
    label: validation.fieldName,
    description: validation.summary,
    tooltip: JSON.stringify(validation.details, null, 2),
    iconPath: new vscode.ThemeIcon('shield'),
    contextValue: 'fmLayoutInspectorValidation'
  });
}

function emptyItem(label: string): LayoutInspectorItem {
  return new LayoutInspectorItem({
    kind: 'placeholder',
    label,
    iconPath: new vscode.ThemeIcon('info')
  });
}
