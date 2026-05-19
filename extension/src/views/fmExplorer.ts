import * as vscode from 'vscode';

import type { EnvironmentSetStore } from '../enterprise/environmentSetStore';
import type { OfflineModeService } from '../offline/offlineModeService';
import type { FMClient } from '../services/fmClient';
import type { JobRunner } from '../services/jobRunner';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SavedQueriesStore } from '../services/savedQueriesStore';
import type { SchemaService } from '../services/schemaService';
import type { SchemaSnapshotStore } from '../services/schemaSnapshotStore';
import type { ConnectionProfile, FileMakerFieldMetadata, JobRuntimeState } from '../types/fm';
import { extractValueLists } from '../utils/valueListParser';

export type ExplorerNodeKind =
  | 'offlineBadge'
  | 'jobsRoot'
  | 'job'
  | 'environmentSetsRoot'
  | 'environmentSet'
  | 'environmentSetAction'
  | 'profile'
  | 'savedQueriesRoot'
  | 'savedQuery'
  | 'layout'
  | 'fieldsRoot'
  | 'field'
  | 'schemaSnapshotsRoot'
  | 'schemaSnapshot'
  | 'schemaDiffAction'
  | 'valueListsRoot'
  | 'valueList'
  | 'placeholder';

export class FMExplorerItem extends vscode.TreeItem {
  public readonly kind: ExplorerNodeKind;
  public readonly profileId?: string;
  public readonly layoutName?: string;
  public readonly queryId?: string;
  public readonly fieldName?: string;
  public readonly snapshotId?: string;
  public readonly jobId?: string;
  public readonly environmentSetId?: string;

  public constructor(options: {
    kind: ExplorerNodeKind;
    label: string;
    collapsibleState?: vscode.TreeItemCollapsibleState;
    profileId?: string;
    layoutName?: string;
    queryId?: string;
    fieldName?: string;
    snapshotId?: string;
    jobId?: string;
    environmentSetId?: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    command?: vscode.Command;
    iconPath?: vscode.ThemeIcon;
  }) {
    super(options.label, options.collapsibleState ?? vscode.TreeItemCollapsibleState.None);

    this.kind = options.kind;
    this.profileId = options.profileId;
    this.layoutName = options.layoutName;
    this.queryId = options.queryId;
    this.fieldName = options.fieldName;
    this.snapshotId = options.snapshotId;
    this.jobId = options.jobId;
    this.environmentSetId = options.environmentSetId;
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.contextValue = options.contextValue;
    this.command = options.command;
    this.iconPath = options.iconPath;
  }
}

export class FMExplorerProvider implements vscode.TreeDataProvider<FMExplorerItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<FMExplorerItem | undefined>();

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly profileStore: ProfileStore,
    private readonly savedQueriesStore: SavedQueriesStore,
    private readonly fmClient: FMClient,
    private readonly schemaService: SchemaService,
    private readonly snapshotStore: SchemaSnapshotStore,
    private readonly jobRunner: JobRunner,
    private readonly environmentSetStore: EnvironmentSetStore,
    private readonly offlineModeService: OfflineModeService,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  ) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public async getTreeItem(element: FMExplorerItem): Promise<vscode.TreeItem> {
    return element;
  }

  public async getChildren(element?: FMExplorerItem): Promise<FMExplorerItem[]> {
    if (!element) {
      return this.getRootItems();
    }

    switch (element.kind) {
      case 'environmentSetsRoot':
        return this.getEnvironmentSetItems();
      case 'environmentSet':
        return this.getEnvironmentSetChildren(element.environmentSetId);
      case 'jobsRoot':
        return this.getJobItems();
      case 'profile':
        return this.getProfileChildren(element.profileId);
      case 'savedQueriesRoot':
        return this.getSavedQueryItems(element.profileId);
      case 'layout':
        return this.getLayoutChildren(element.profileId, element.layoutName);
      case 'fieldsRoot':
        return this.getFieldItems(element.profileId, element.layoutName);
      case 'schemaSnapshotsRoot':
        return this.getSchemaSnapshotItems(element.profileId, element.layoutName);
      case 'valueListsRoot':
        return this.getValueListItems(element.profileId, element.layoutName);
      default:
        return [];
    }
  }

  private async getRootItems(): Promise<FMExplorerItem[]> {
    const items: FMExplorerItem[] = [];
    const offlineActive = this.offlineModeService.isOfflineModeEnabled();

    if (offlineActive) {
      items.push(
        new FMExplorerItem({
          kind: 'offlineBadge',
          label: 'OFFLINE MODE',
          description: 'Metadata cache only',
          tooltip: 'Offline mode is enabled. Write operations are disabled.',
          iconPath: new vscode.ThemeIcon('cloud-offline'),
          contextValue: 'fmOfflineBadge',
          command: {
            command: 'filemakerDataApiTools.toggleOfflineMode',
            title: 'Toggle Offline Mode'
          }
        })
      );
    }

    const profiles = await this.profileStore.listProfiles();

    // Empty-state path: when the user has no profiles yet and nothing else is
    // demanding attention (offline badge, env sets, jobs), return zero children
    // so VS Code renders the contributes.viewsWelcome markdown (which holds the
    // primary "Add Connection Profile" / "Open Walkthrough" CTAs). Putting any
    // root node here suppresses viewsWelcome and leaves new users staring at
    // empty collapsibles instead of a real call to action.
    if (profiles.length === 0) {
      const envSets = await this.environmentSetStore.listEnvironmentSets();
      const jobs = this.jobRunner.listJobs();
      if (!offlineActive && envSets.length === 0 && jobs.length === 0) {
        return [];
      }
    }

    // Hide Environment Sets entirely until the user has at least one set or
    // we're in a state where env-set children are meaningful. Same idea for
    // Jobs: don't surface a node that's just going to say "No active jobs".
    const envSets = await this.environmentSetStore.listEnvironmentSets();
    if (envSets.length > 0) {
      items.push(
        new FMExplorerItem({
          kind: 'environmentSetsRoot',
          label: 'Environment Sets',
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          contextValue: 'fmEnvironmentSetsRoot',
          iconPath: new vscode.ThemeIcon('organization')
        })
      );
    }

    const jobs = this.jobRunner.listJobs();
    if (jobs.length > 0) {
      items.push(
        new FMExplorerItem({
          kind: 'jobsRoot',
          label: 'Jobs',
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          contextValue: 'fmJobsRoot',
          iconPath: new vscode.ThemeIcon('history')
        })
      );
    }

    if (profiles.length > 0) {
      const profileItems = await this.getProfileItems();
      items.push(...profileItems);
    }

    return items;
  }

  private async getEnvironmentSetItems(): Promise<FMExplorerItem[]> {
    const sets = await this.environmentSetStore.listEnvironmentSets();
    if (sets.length === 0) {
      return [
        new FMExplorerItem({
          kind: 'placeholder',
          label: 'No environment sets',
          description: 'Run FileMaker: Create Environment Set',
          iconPath: new vscode.ThemeIcon('info'),
          command: {
            command: 'filemakerDataApiTools.createEnvironmentSet',
            title: 'Create Environment Set'
          }
        })
      ];
    }

    return sets.map(
      (set) =>
        new FMExplorerItem({
          kind: 'environmentSet',
          label: set.name,
          environmentSetId: set.id,
          description: `${set.profiles.length} profiles`,
          tooltip: `${set.profiles.join('\n')}\nCreated: ${set.createdAt}`,
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          contextValue: 'fmEnvironmentSet',
          iconPath: new vscode.ThemeIcon('organization'),
          command: {
            command: 'filemakerDataApiTools.compareEnvironments',
            title: 'Compare Environments',
            arguments: [{ environmentSetId: set.id }]
          }
        })
    );
  }

  private async getEnvironmentSetChildren(environmentSetId: string | undefined): Promise<FMExplorerItem[]> {
    if (!environmentSetId) {
      return [];
    }

    return [
      new FMExplorerItem({
        kind: 'environmentSetAction',
        label: 'Compare Environments',
        environmentSetId,
        contextValue: 'fmEnvironmentSetAction',
        iconPath: new vscode.ThemeIcon('diff'),
        command: {
          command: 'filemakerDataApiTools.compareEnvironments',
          title: 'Compare Environments',
          arguments: [{ environmentSetId }]
        }
      }),
      new FMExplorerItem({
        kind: 'environmentSetAction',
        label: 'Diff Layout Across Environments…',
        environmentSetId,
        contextValue: 'fmEnvironmentSetAction',
        iconPath: new vscode.ThemeIcon('symbol-structure'),
        command: {
          command: 'filemakerDataApiTools.diffLayoutAcrossEnvironments',
          title: 'Diff Layout Across Environments',
          arguments: [{ environmentSetId }]
        }
      }),
      new FMExplorerItem({
        kind: 'environmentSetAction',
        label: 'Export Comparison Report',
        environmentSetId,
        contextValue: 'fmEnvironmentSetAction',
        iconPath: new vscode.ThemeIcon('export'),
        command: {
          command: 'filemakerDataApiTools.exportEnvironmentComparisonReport',
          title: 'Export Environment Comparison Report',
          arguments: [{ environmentSetId }]
        }
      }),
      new FMExplorerItem({
        kind: 'environmentSetAction',
        label: 'Open Set JSON',
        environmentSetId,
        contextValue: 'fmEnvironmentSetAction',
        iconPath: new vscode.ThemeIcon('json'),
        command: {
          command: 'filemakerDataApiTools.openEnvironmentSetJson',
          title: 'Open Environment Set JSON',
          arguments: [{ environmentSetId }]
        }
      })
    ];
  }

  private async getJobItems(): Promise<FMExplorerItem[]> {
    const jobs = this.jobRunner.listJobs();
    if (jobs.length === 0) {
      return [
        new FMExplorerItem({
          kind: 'placeholder',
          label: 'No active jobs',
          description: 'Run FileMaker: Show Jobs for recent history.',
          iconPath: new vscode.ThemeIcon('info')
        })
      ];
    }

    return jobs.map((job) => this.toJobTreeItem(job));
  }

  private toJobTreeItem(job: JobRuntimeState): FMExplorerItem {
    return new FMExplorerItem({
      kind: 'job',
      label: job.name,
      jobId: job.id,
      description: `${job.status} • ${job.progress}%`,
      tooltip: `${job.startedAt}${job.details ? `\n${job.details}` : ''}`,
      contextValue: 'fmJob',
      iconPath: new vscode.ThemeIcon(job.status === 'failed' ? 'error' : 'history'),
      command: {
        command: 'filemakerDataApiTools.showJobs',
        title: 'Show Jobs'
      }
    });
  }

  private async getProfileItems(): Promise<FMExplorerItem[]> {
    const profiles = await this.profileStore.listProfiles();

    if (profiles.length === 0) {
      return [
        new FMExplorerItem({
          kind: 'placeholder',
          label: 'No connection profiles configured',
          description: 'Run FileMaker: Add Connection Profile',
          tooltip: 'Create a FileMaker connection profile to get started.',
          command: {
            command: 'filemakerDataApiTools.addConnectionProfile',
            title: 'Add Connection Profile'
          },
          iconPath: new vscode.ThemeIcon('info')
        })
      ];
    }

    const activeProfileId = this.profileStore.getActiveProfileId();

    return profiles.map((profile) => {
      const connected = profile.id === activeProfileId;
      const contextValue = connected ? 'fmProfileConnected' : 'fmProfile';

      return new FMExplorerItem({
        kind: 'profile',
        label: profile.name,
        profileId: profile.id,
        description: `${profile.database} (${profile.authMode})`,
        tooltip: `${profile.serverUrl}\nDatabase: ${profile.database}`,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue,
        iconPath: connected ? new vscode.ThemeIcon('plug') : new vscode.ThemeIcon('circle-outline')
      });
    });
  }

  private async getProfileChildren(profileId: string | undefined): Promise<FMExplorerItem[]> {
    if (!profileId) {
      return [];
    }

    const children: FMExplorerItem[] = [
      new FMExplorerItem({
        kind: 'savedQueriesRoot',
        label: 'Saved Queries',
        profileId,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: 'fmSavedQueriesRoot',
        iconPath: new vscode.ThemeIcon('bookmark')
      })
    ];

    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      return children;
    }

    try {
      const layouts = await this.fmClient.listLayouts(profile);

      if (layouts.length === 0) {
        children.push(
          new FMExplorerItem({
            kind: 'placeholder',
            label: 'No layouts found',
            description: 'Check profile permissions or API endpoint.',
            iconPath: new vscode.ThemeIcon('warning')
          })
        );

        return children;
      }

      children.push(
        ...layouts.map(
          (layout) =>
            new FMExplorerItem({
              kind: 'layout',
              label: layout,
              profileId,
              layoutName: layout,
              tooltip: `Layout: ${layout}`,
              collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
              contextValue: 'fmLayout',
              iconPath: new vscode.ThemeIcon('table')
            })
        )
      );
    } catch (error) {
      this.logger.warn('Failed to list layouts for profile in explorer.', {
        profileId,
        error
      });

      children.push(
        new FMExplorerItem({
          kind: 'placeholder',
          label: 'Failed to load layouts',
          description: 'Use FileMaker: Connect, then refresh explorer.',
          iconPath: new vscode.ThemeIcon('error')
        })
      );
    }

    return children;
  }

  private async getSavedQueryItems(profileId: string | undefined): Promise<FMExplorerItem[]> {
    if (!profileId) {
      return [];
    }

    const queries = await this.savedQueriesStore.listSavedQueries({ profileId });

    if (queries.length === 0) {
      return [
        new FMExplorerItem({
          kind: 'placeholder',
          label: 'No saved queries',
          description: 'Use Query Builder to save one.',
          iconPath: new vscode.ThemeIcon('info')
        })
      ];
    }

    return queries.map(
      (query) =>
        new FMExplorerItem({
          kind: 'savedQuery',
          label: query.name,
          profileId,
          queryId: query.id,
          description: query.layout,
          tooltip: `${query.layout}${query.lastRunAt ? `\nLast run: ${query.lastRunAt}` : ''}`,
          contextValue: 'fmSavedQuery',
          command: {
            command: 'filemakerDataApiTools.openSavedQuery',
            title: 'Open Saved Query',
            arguments: [
              {
                profileId,
                queryId: query.id
              }
            ]
          },
          iconPath: new vscode.ThemeIcon('symbol-constant')
        })
    );
  }

  private async getLayoutChildren(
    profileId: string | undefined,
    layoutName: string | undefined
  ): Promise<FMExplorerItem[]> {
    if (!profileId || !layoutName) {
      return [];
    }

    return [
      new FMExplorerItem({
        kind: 'fieldsRoot',
        label: 'Fields',
        profileId,
        layoutName,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: 'fmFieldsRoot',
        iconPath: new vscode.ThemeIcon('symbol-field')
      }),
      new FMExplorerItem({
        kind: 'valueListsRoot',
        label: 'Value Lists',
        profileId,
        layoutName,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: 'fmValueListsRoot',
        iconPath: new vscode.ThemeIcon('list-unordered')
      }),
      new FMExplorerItem({
        kind: 'schemaSnapshotsRoot',
        label: 'Schema Snapshots',
        profileId,
        layoutName,
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: 'fmSchemaSnapshotsRoot',
        iconPath: new vscode.ThemeIcon('versions')
      }),
      new FMExplorerItem({
        kind: 'schemaDiffAction',
        label: 'Diff Snapshots…',
        profileId,
        layoutName,
        contextValue: 'fmSchemaDiffAction',
        command: {
          command: 'filemakerDataApiTools.diffSchemaSnapshots',
          title: 'Diff Schema Snapshots',
          arguments: [{ profileId, layout: layoutName }]
        },
        iconPath: new vscode.ThemeIcon('diff')
      })
    ];
  }

  private async getSchemaSnapshotItems(
    profileId: string | undefined,
    layoutName: string | undefined
  ): Promise<FMExplorerItem[]> {
    if (!profileId || !layoutName) {
      return [];
    }

    const snapshots = await this.snapshotStore.listSnapshots({
      profileId,
      layout: layoutName
    });

    if (snapshots.length === 0) {
      return [
        new FMExplorerItem({
          kind: 'placeholder',
          label: 'No snapshots captured',
          description: 'Run FileMaker: Capture Schema Snapshot',
          iconPath: new vscode.ThemeIcon('info')
        })
      ];
    }

    return snapshots.map(
      (snapshot) =>
        new FMExplorerItem({
          kind: 'schemaSnapshot',
          label: snapshot.capturedAt,
          profileId,
          layoutName,
          snapshotId: snapshot.id,
          description: snapshot.source,
          tooltip: `${snapshot.id}\n${snapshot.capturedAt}`,
          contextValue: 'fmSchemaSnapshot',
          iconPath: new vscode.ThemeIcon('history'),
          command: {
            command: 'filemakerDataApiTools.openSchemaSnapshotJson',
            title: 'Open Schema Snapshot JSON',
            arguments: [{ snapshotId: snapshot.id }]
          }
        })
    );
  }

  private async getFieldItems(
    profileId: string | undefined,
    layoutName: string | undefined
  ): Promise<FMExplorerItem[]> {
    if (!profileId || !layoutName) {
      return [];
    }

    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      return [];
    }

    try {
      const schema = await this.schemaService.getFields(profile, layoutName);

      if (!schema.supported) {
        return [
          new FMExplorerItem({
            kind: 'placeholder',
            label: 'Metadata not supported on this server/profile.',
            description: 'Open Layout Metadata for raw endpoint response.',
            iconPath: new vscode.ThemeIcon('warning')
          })
        ];
      }

      if (schema.fields.length === 0) {
        return [
          new FMExplorerItem({
            kind: 'placeholder',
            label: 'No field metadata found',
            description: schema.message,
            iconPath: new vscode.ThemeIcon('info')
          })
        ];
      }

      return schema.fields.map((field) => toFieldTreeItem(field, profileId, layoutName));
    } catch (error) {
      this.logger.warn('Failed to load field metadata for layout.', {
        profileId,
        layoutName,
        error
      });

      return [
        new FMExplorerItem({
          kind: 'placeholder',
          label: 'Failed to load fields',
          description: 'Use FileMaker: Refresh Schema Cache and try again.',
          iconPath: new vscode.ThemeIcon('error')
        })
      ];
    }
  }

  private async getValueListItems(
    profileId: string | undefined,
    layoutName: string | undefined
  ): Promise<FMExplorerItem[]> {
    if (!profileId || !layoutName) {
      return [];
    }

    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      return [];
    }

    try {
      const schema = await this.schemaService.getFields(profile, layoutName);

      if (!schema.supported || !schema.metadata) {
        return [
          new FMExplorerItem({
            kind: 'placeholder',
            label: 'Value lists not available',
            iconPath: new vscode.ThemeIcon('info')
          })
        ];
      }

      const valueLists = extractValueLists(schema.metadata);

      if (valueLists.length === 0) {
        return [
          new FMExplorerItem({
            kind: 'placeholder',
            label: 'No value lists on this layout',
            iconPath: new vscode.ThemeIcon('info')
          })
        ];
      }

      return valueLists.map(
        (vl) =>
          new FMExplorerItem({
            kind: 'valueList',
            label: vl.name,
            description: `${vl.values.length} item${vl.values.length === 1 ? '' : 's'}`,
            profileId,
            layoutName,
            contextValue: 'fmValueList',
            iconPath: new vscode.ThemeIcon('list-unordered')
          })
      );
    } catch {
      return [
        new FMExplorerItem({
          kind: 'placeholder',
          label: 'Failed to load value lists',
          iconPath: new vscode.ThemeIcon('error')
        })
      ];
    }
  }

  public async resolveProfile(itemOrId: FMExplorerItem | string): Promise<ConnectionProfile | undefined> {
    const profileId = typeof itemOrId === 'string' ? itemOrId : itemOrId.profileId;
    if (!profileId) {
      return undefined;
    }

    return this.profileStore.getProfile(profileId);
  }
}

function toFieldTreeItem(
  field: FileMakerFieldMetadata,
  profileId: string,
  layoutName: string
): FMExplorerItem {
  const descriptionParts: string[] = [];

  if (field.result) {
    descriptionParts.push(field.result);
  }

  if (typeof field.repetitions === 'number') {
    descriptionParts.push(`x${field.repetitions}`);
  }

  const tooltip = [
    `Field: ${field.name}`,
    field.result ? `Type: ${field.result}` : undefined,
    typeof field.repetitions === 'number' ? `Repetitions: ${field.repetitions}` : undefined,
    field.validation ? `Validation: ${JSON.stringify(field.validation)}` : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  return new FMExplorerItem({
    kind: 'field',
    label: field.name,
    profileId,
    layoutName,
    fieldName: field.name,
    description: descriptionParts.length > 0 ? descriptionParts.join(' • ') : undefined,
    tooltip,
    contextValue: 'fmField',
    iconPath: new vscode.ThemeIcon('symbol-field')
  });
}
