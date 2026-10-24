import { z } from 'zod';

export const CURRENT_LAYOUT_SCHEMA_VERSION = 1;

const anchorSchema = z.object({
  top: z.boolean().default(true),
  right: z.boolean().default(false),
  bottom: z.boolean().default(false),
  left: z.boolean().default(true)
});

const styleRefSchema = z.object({
  token: z.string().min(1)
});

const behaviorBindingSchema = z.object({
  type: z.enum(['runScript', 'goToWebLayout', 'goToFmLayout', 'openUrl', 'showDialog']).optional(),
  scriptName: z.string().optional(),
  targetLayoutId: z.string().optional(),
  targetFmLayoutName: z.string().optional(),
  url: z.string().optional(),
  dialogId: z.string().optional(),
  parameter: z.string().optional()
});

const objectBaseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  zIndex: z.number().int().nonnegative().default(0),
  anchors: anchorSchema.default({
    top: true,
    right: false,
    bottom: false,
    left: true
  }),
  style: styleRefSchema.optional(),
  behavior: behaviorBindingSchema.optional()
});

const fieldDisplaySchema = z.enum(['editBox', 'dropdown', 'checkbox', 'radio']);
const fieldFormatSchema = z.enum(['text', 'number', 'date']);

const fieldObjectSchema = objectBaseSchema.extend({
  type: z.literal('field'),
  fmFieldName: z.string().min(1),
  displayType: fieldDisplaySchema.default('editBox'),
  format: fieldFormatSchema.default('text'),
  kind: z.enum(['normal', 'calculation', 'summary', 'container', 'global']).catch('normal').default('normal').optional(),
  metadata: z.object({ type: z.string().optional(), result: z.string().optional() }).optional(),
  result: z.string().optional(),
  multiline: z.boolean().default(false).optional(),
  options: z.array(z.string()).optional(),
  label: z.string().optional(),
  labelPosition: z.enum(['top', 'left', 'right', 'none']).default('top'),
  required: z.boolean().default(false)
});

const textObjectSchema = objectBaseSchema.extend({
  type: z.literal('text'),
  text: z.string().default('Text')
});

const buttonObjectSchema = objectBaseSchema.extend({
  type: z.literal('button'),
  label: z.string().default('Button')
});

const portalColumnSchema = z.object({
  id: z.string().uuid(),
  fmFieldName: z.string().min(1),
  label: z.string().min(1),
  width: z.number().int().positive()
});

const portalObjectSchema = objectBaseSchema.extend({
  type: z.literal('portal'),
  relatedContext: z.string().default(''),
  rowCount: z.number().int().min(1).max(500).default(5),
  columns: z.array(portalColumnSchema).default([]),
  scroll: z.boolean().default(true),
  selectableRows: z.boolean().default(false)
});

const rectangleObjectSchema = objectBaseSchema.extend({
  type: z.literal('rectangle'),
  cornerRadius: z.number().int().min(0).max(64).default(0)
});

const imageObjectSchema = objectBaseSchema.extend({
  type: z.literal('image'),
  src: z.string().optional(),
  alt: z.string().optional()
});

const tabPanelObjectSchema = objectBaseSchema.extend({
  type: z.literal('tabPanel'),
  tabs: z
    .array(
      z.object({
        id: z.string().uuid(),
        label: z.string().min(1)
      })
    )
    .default([])
});

const layoutObjectSchema = z.discriminatedUnion('type', [
  fieldObjectSchema,
  textObjectSchema,
  buttonObjectSchema,
  portalObjectSchema,
  rectangleObjectSchema,
  imageObjectSchema,
  tabPanelObjectSchema
]);

const designTokensSchema = z.object({
  colors: z
    .object({
      canvas: z.string().default('#f6f7f9'),
      surface: z.string().default('#ffffff'),
      text: z.string().default('#13202e'),
      accent: z.string().default('#2274a5')
    })
    .default({
      canvas: '#f6f7f9',
      surface: '#ffffff',
      text: '#13202e',
      accent: '#2274a5'
    }),
  typography: z
    .object({
      fontFamily: z.string().default('"IBM Plex Sans", sans-serif'),
      fontSize: z.number().int().positive().default(13)
    })
    .default({
      fontFamily: '"IBM Plex Sans", sans-serif',
      fontSize: 13
    })
});

export const layoutDefinitionSchema = z.object({
  schemaVersion: z.literal(CURRENT_LAYOUT_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string().min(1),
  fmLayoutName: z.string().optional(),
  canvas: z.object({
    width: z.number().int().positive().default(1280),
    height: z.number().int().positive().default(800),
    gridSize: z.number().int().min(1).max(128).default(8)
  }),
  objects: z.array(layoutObjectSchema).default([]),
  styles: designTokensSchema
});

export type AnchorConstraints = z.infer<typeof anchorSchema>;
export type BehaviorBinding = z.infer<typeof behaviorBindingSchema>;
export type DesignTokens = z.infer<typeof designTokensSchema>;
export type LayoutObject = z.infer<typeof layoutObjectSchema>;
export type FieldLayoutObject = z.infer<typeof fieldObjectSchema>;
export type PortalLayoutObject = z.infer<typeof portalObjectSchema>;
export type LayoutDefinition = z.infer<typeof layoutDefinitionSchema>;

interface LayoutMigration {
  from: number;
  to: number;
  migrate: (input: unknown) => unknown;
}

const migrations: LayoutMigration[] = [
  {
    from: 0,
    to: 1,
    migrate: migrateFromLegacy
  }
];

export function validateLayoutDefinition(input: unknown): LayoutDefinition {
  return layoutDefinitionSchema.parse(input);
}

export function migrateLayoutDefinition(input: unknown): LayoutDefinition {
  const withVersion = detectVersionedInput(input);

  if (withVersion.schemaVersion > CURRENT_LAYOUT_SCHEMA_VERSION) {
    throw new Error(
      `Layout schema version ${withVersion.schemaVersion} is newer than supported version ${CURRENT_LAYOUT_SCHEMA_VERSION}.`
    );
  }

  let currentVersion = withVersion.schemaVersion;
  let currentValue: unknown = withVersion.value;

  while (currentVersion < CURRENT_LAYOUT_SCHEMA_VERSION) {
    const migration = migrations.find((item) => item.from === currentVersion);
    if (!migration) {
      throw new Error(`No migration registered for schema version ${currentVersion}.`);
    }

    currentValue = migration.migrate(currentValue);
    currentVersion = migration.to;
  }

  return validateLayoutDefinition(currentValue);
}

export function createBlankLayout(name: string, fmLayoutName?: string): LayoutDefinition {
  return {
    schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
    id: createUuid(),
    name,
    fmLayoutName,
    canvas: {
      width: 1280,
      height: 800,
      gridSize: 8
    },
    objects: [],
    styles: {
      colors: {
        canvas: '#f6f7f9',
        surface: '#ffffff',
        text: '#13202e',
        accent: '#2274a5'
      },
      typography: {
        fontFamily: '"IBM Plex Sans", sans-serif',
        fontSize: 13
      }
    }
  };
}

function detectVersionedInput(input: unknown): { schemaVersion: number; value: unknown } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { schemaVersion: 0, value: input };
  }

  const objectInput = input as Record<string, unknown>;
  const rawSchemaVersion = objectInput.schemaVersion;

  if (typeof rawSchemaVersion === 'number' && Number.isInteger(rawSchemaVersion) && rawSchemaVersion >= 0) {
    return {
      schemaVersion: rawSchemaVersion,
      value: objectInput
    };
  }

  return {
    schemaVersion: 0,
    value: objectInput
  };
}

function migrateFromLegacy(input: unknown): LayoutDefinition {
  const objectInput = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const name = typeof objectInput.name === 'string' && objectInput.name.trim().length > 0 ? objectInput.name.trim() : 'Untitled Layout';

  return {
    ...createBlankLayout(name, typeof objectInput.fmLayoutName === 'string' ? objectInput.fmLayoutName : undefined),
    objects: normalizeLegacyObjects(objectInput.objects)
  };
}

function normalizeLegacyObjects(rawObjects: unknown): LayoutObject[] {
  if (!Array.isArray(rawObjects)) {
    return [];
  }

  const normalized: LayoutObject[] = [];

  for (const item of rawObjects) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const objectValue = item as Record<string, unknown>;
    const type = typeof objectValue.type === 'string' ? objectValue.type : 'rectangle';

    const base = {
      id: typeof objectValue.id === 'string' ? objectValue.id : createUuid(),
      name: typeof objectValue.name === 'string' ? objectValue.name : `${type}-${normalized.length + 1}`,
      x: toInt(objectValue.x, 0),
      y: toInt(objectValue.y, 0),
      width: Math.max(toInt(objectValue.width, 120), 1),
      height: Math.max(toInt(objectValue.height, 32), 1),
      zIndex: Math.max(toInt(objectValue.zIndex, normalized.length), 0),
      anchors: {
        top: true,
        right: false,
        bottom: false,
        left: true
      }
    };

    if (type === 'field') {
      normalized.push({
        ...base,
        type: 'field',
        fmFieldName: typeof objectValue.fmFieldName === 'string' ? objectValue.fmFieldName : 'Field',
        displayType: 'editBox',
        format: 'text',
        labelPosition: 'top',
        required: false
      });
      continue;
    }

    if (type === 'text') {
      normalized.push({
        ...base,
        type: 'text',
        text: typeof objectValue.text === 'string' ? objectValue.text : 'Text'
      });
      continue;
    }

    if (type === 'button') {
      normalized.push({
        ...base,
        type: 'button',
        label: typeof objectValue.label === 'string' ? objectValue.label : 'Button'
      });
      continue;
    }

    if (type === 'portal') {
      normalized.push({
        ...base,
        type: 'portal',
        relatedContext: typeof objectValue.relatedContext === 'string' ? objectValue.relatedContext : '',
        rowCount: Math.max(toInt(objectValue.rowCount, 5), 1),
        columns: [],
        scroll: true,
        selectableRows: false
      });
      continue;
    }

    if (type === 'image') {
      normalized.push({
        ...base,
        type: 'image'
      });
      continue;
    }

    if (type === 'tabPanel') {
      normalized.push({
        ...base,
        type: 'tabPanel',
        tabs: []
      });
      continue;
    }

    normalized.push({
      ...base,
      type: 'rectangle',
      cornerRadius: 0
    });
  }

  return normalized;
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }

  return fallback;
}

function createUuid(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}
