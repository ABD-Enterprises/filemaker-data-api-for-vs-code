// fmweb-managed: runtime template v3. The FileMaker Data API Tools extension refreshes this file when the template version changes; keep your own changes in other files.
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { LayoutContainer, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';

import { executeRuntimeBehaviorAction, type RuntimeBehaviorResult } from '../../../lib/runtime-behavior';
import { useRuntimeDataController } from '../../../lib/runtime-data';
import {
  consumeNavigationIntent,
  saveNavigationIntent,
  type RuntimeNavigationIntent
} from '../../../lib/runtime-session';

interface RuntimeLayoutClientProps {
  layout: LayoutDefinition;
  initialRecordId?: string;
  initialRecordIndex?: number;
}

export function RuntimeLayoutClient({
  layout,
  initialRecordId,
  initialRecordIndex
}: RuntimeLayoutClientProps): React.JSX.Element {
  const router = useRouter();
  const canvasHostRef = React.useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = React.useState<{ width: number; height: number } | undefined>(undefined);
  const [result, setResult] = React.useState<RuntimeBehaviorResult | undefined>(undefined);
  const [navigationIntent, setNavigationIntent] = React.useState<RuntimeNavigationIntent | undefined>(undefined);

  React.useEffect(() => {
    const consumed = consumeNavigationIntent(layout.id);
    setNavigationIntent(consumed);
  }, [layout.id]);

  const resolvedInitialRecordId = initialRecordId ?? navigationIntent?.recordId;
  const resolvedInitialRecordIndex = initialRecordIndex ?? navigationIntent?.currentRecordIndex;
  const runtime = useRuntimeDataController(layout, viewport, {
    initialRecordId: resolvedInitialRecordId,
    initialRecordIndex: resolvedInitialRecordIndex
  });

  React.useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const next = entries[0];
      if (!next) {
        return;
      }

      const width = Math.floor(next.contentRect.width);
      const height = Math.floor(next.contentRect.height);
      if (width > 0 && height > 0) {
        setViewport({ width, height });
      }
    });

    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const handleObjectAction = React.useCallback(
    async (object: LayoutObject): Promise<void> => {
      const actionResult = await executeRuntimeBehaviorAction(object, {
        layoutId: layout.id,
        layoutName: layout.name,
        fmLayoutName: layout.fmLayoutName,
        bridgeBaseUrl: process.env.NEXT_PUBLIC_FMWEB_BRIDGE_URL,
        bridgeToken: process.env.NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN,
        currentRecordId: runtime.currentRecord?.recordId,
        currentRecordIndex: runtime.currentIndex,
        currentFoundSetRecordIds: runtime.foundSet.map((record) => record.recordId),
        navigateToLayout: (layoutId, state) => {
          saveNavigationIntent({
            targetLayoutId: layoutId,
            sourceLayoutId: state?.sourceLayoutId ?? layout.id,
            sourceLayoutName: state?.sourceLayoutName ?? layout.name,
            sourceFmLayoutName: state?.sourceFmLayoutName ?? layout.fmLayoutName,
            recordId: state?.recordId,
            currentRecordIndex: state?.currentRecordIndex,
            foundSetRecordIds: state?.foundSetRecordIds
          });

          const query = new URLSearchParams();
          if (state?.recordId) {
            query.set('recordId', state.recordId);
          }
          if (typeof state?.currentRecordIndex === 'number' && Number.isFinite(state.currentRecordIndex)) {
            query.set('foundIndex', String(Math.max(0, Math.floor(state.currentRecordIndex))));
          }
          if (state?.sourceLayoutId) {
            query.set('fromLayoutId', state.sourceLayoutId);
          }

          const encodedId = encodeURIComponent(layoutId);
          const queryString = query.toString();
          router.push(queryString ? `/layouts/${encodedId}?${queryString}` : `/layouts/${encodedId}`);
        },
        openUrl: (url) => {
          window.open(url, '_blank', 'noopener,noreferrer');
        },
        showDialog: (dialogId, parameter) => {
          const suffix = parameter ? `\n\nParameter: ${parameter}` : '';
          window.alert(`Dialog: ${dialogId}${suffix}`);
        }
      });

      setResult(actionResult);
    },
    [
      layout.fmLayoutName,
      layout.id,
      layout.name,
      router,
      runtime.currentIndex,
      runtime.currentRecord?.recordId,
      runtime.foundSet
    ]
  );

  return (
    <>
      <div className="runtime-layout-header">
        <h1>{layout.name}</h1>
        <p>
          Bridge: {process.env.NEXT_PUBLIC_FMWEB_BRIDGE_URL ? 'connected' : 'stub mode (no bridge URL)'}
        </p>
        <div className="runtime-toolbar">
          <button type="button" onClick={() => void runtime.findAll()} disabled={runtime.loading}>
            Find
          </button>
          <button
            type="button"
            onClick={runtime.prevRecord}
            disabled={runtime.loading || runtime.currentIndex <= 0}
          >
            Prev
          </button>
          <button
            type="button"
            onClick={runtime.nextRecord}
            disabled={runtime.loading || runtime.currentIndex >= runtime.foundSet.length - 1}
          >
            Next
          </button>
          <button
            type="button"
            onClick={() => void runtime.reloadRecord()}
            disabled={runtime.loading || !runtime.currentRecord}
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => void runtime.editCurrentRecord({ LastViewedAt: new Date().toISOString() })}
            disabled={runtime.loading || !runtime.currentRecord}
          >
            Save Stamp
          </button>
          <button type="button" onClick={() => void runtime.createRecord({})} disabled={runtime.loading}>
            Create
          </button>
          <button
            type="button"
            onClick={() => void runtime.deleteCurrentRecord()}
            disabled={runtime.loading || !runtime.currentRecord}
          >
            Delete
          </button>
        </div>
        <p>
          Record: {runtime.currentRecord ? runtime.currentRecord.recordId : 'none'} ({runtime.currentIndex + 1}/
          {Math.max(1, runtime.foundSet.length)}) {runtime.loading ? 'Loading...' : ''}
        </p>
      </div>
      <div className="runtime-canvas-host" ref={canvasHostRef}>
        <LayoutContainer
          layout={layout}
          mode="runtime"
          onObjectAction={handleObjectAction}
          runtimeData={runtime.runtimeData}
        />
      </div>
      <div className="runtime-action-result">
        <span>{runtime.statusMessage}</span>
      </div>
      <div className={`runtime-action-result ${result ? (result.ok ? 'ok' : 'error') : ''}`}>
        {result ? (
          <>
            <strong>{result.ok ? 'OK' : 'ERROR'}</strong>
            {result.stub ? <span> [stub]</span> : null}
            <span>: {result.message}</span>
          </>
        ) : (
          <span>Click a bound button in the layout to execute its behavior.</span>
        )}
      </div>
    </>
  );
}
