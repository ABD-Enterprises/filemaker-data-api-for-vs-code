import * as vscode from 'vscode';
import type { FileMakerRecord } from '../../types/fm';
import { recordsToCsv } from '../../utils/exportCsv';
import { exportColumns, exportRow, portalNotes } from '../../utils/exportRecords';
import { atomicExport } from '../../utils/atomicExport';
import { isFormulaNeutralizationOn } from '../../utils/userScopeSetting';
import { deliverSnippet } from '../../snippets/deliver';
import type { CopySnippetPayload, QueryExecutionResult } from './types';
import type { QueryBuilderContext } from './context';
import { toFindRequest } from './find';

export async function exportResultsToEditor(context: QueryBuilderContext): Promise<void> {
  if (!context.lastResult) {
    await context.postError('No query results available to export.');
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(context.lastResult, null, 2)
  });

  await vscode.window.showTextDocument(document, { preview: false });
}

export async function exportResultsJsonFile(context: QueryBuilderContext): Promise<void> {
  if (!context.lastResult) {
    await context.postError('No query results available to export.');
    return;
  }

  const uri = await vscode.window.showSaveDialog({
    title: 'Export Query Results (JSON)',
    filters: {
      JSON: ['json']
    },
    defaultUri: vscode.Uri.file('filemaker-query-results.json')
  });

  if (!uri) {
    return;
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(context.lastResult, null, 2), 'utf8'));

  vscode.window.showInformationMessage('Exported query results JSON file.');
}

export async function exportResultsCsvFile(context: QueryBuilderContext): Promise<void> {
  if (!context.lastResult) {
    await context.postError('No query results available to export.');
    return;
  }

  const rows = context.toCsvRows(context.lastResult);
  const excelChoice = await vscode.window.showQuickPick(['Standard CSV', 'Excel-compatible CSV (UTF-8 BOM)'], { title: 'CSV format' });
  if (!excelChoice) return;
  const csv = recordsToCsv(rows, {
    excelCompatible: excelChoice.startsWith('Excel'),
    neutralizeFormulas: isFormulaNeutralizationOn(vscode.workspace.getConfiguration('filemaker'))
  });

  const uri = await vscode.window.showSaveDialog({
    title: 'Export Query Results (CSV)',
    filters: {
      CSV: ['csv']
    },
    defaultUri: vscode.Uri.file('filemaker-query-results.csv')
  });

  if (!uri) {
    return;
  }

  const file = await atomicExport(uri.fsPath);
  try { await file.write(csv); await file.close(); }
  catch (error) { await file.abort(); throw error; }
  vscode.window.showInformationMessage('Exported query results CSV file.');
}

export function toCsvRows(result: QueryExecutionResult): Array<Map<string, unknown>> {
  const records = result.result.data as FileMakerRecord[];
  const names = [...new Set(records.flatMap((record) => Object.keys(record.fieldData ?? {})))];
  const meta = exportColumns(names);
  let noteColumn: string | undefined;
  if (records.some((record) => portalNotes(record))) {
    noteColumn = '__portalNote (export information)';
    while (names.includes(noteColumn)) noteColumn = '_' + noteColumn;
  }
  return records.map((record) => exportRow(record, meta, noteColumn));
}

export async function copyRequest(context: QueryBuilderContext, payload: CopySnippetPayload): Promise<void> {
  const profile = await context.profileStore.getProfile(payload.profileId);
  if (!profile) {
    await context.postError('Cannot copy the request because the profile was not found.');
    return;
  }

  try {
    await deliverSnippet(
      profile,
      { kind: 'find', layout: payload.layout, request: toFindRequest(payload) },
      payload.delivery
    );
  } catch (error) {
    await context.postError(context.formatError(error));
  }
}
