// Pure conversion between the Query Builder's form model and FileMaker find/sort JSON.
// Loaded as a classic script in the webview (exposes window.FindForm) and required by unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.FindForm = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Operators offered in the form. `toValue` builds the FileMaker find string;
   * `needsValue` / `needsSecondValue` drive which inputs the row shows.
   */
  const OPERATORS = [
    { id: 'match', label: 'matches', needsValue: true },
    { id: 'equals', label: 'equals exactly', needsValue: true },
    { id: 'begins', label: 'begins with', needsValue: true },
    { id: 'contains', label: 'contains', needsValue: true },
    { id: 'gt', label: 'greater than', needsValue: true },
    { id: 'gte', label: 'at least', needsValue: true },
    { id: 'lt', label: 'less than', needsValue: true },
    { id: 'lte', label: 'at most', needsValue: true },
    { id: 'between', label: 'between', needsValue: true, needsSecondValue: true },
    { id: 'empty', label: 'is empty', needsValue: false },
    { id: 'notEmpty', label: 'is not empty', needsValue: false }
  ];

  const OPERATOR_IDS = new Set(OPERATORS.map((operator) => operator.id));

  function getOperator(id) {
    return OPERATORS.find((operator) => operator.id === id) || OPERATORS[0];
  }

  function criterionToFindValue(criterion) {
    const value = String(criterion.value ?? '');
    switch (criterion.operator) {
      case 'equals':
        return `==${value}`;
      case 'begins':
        return `${value}*`;
      case 'contains':
        return `*${value}*`;
      case 'gt':
        return `>${value}`;
      case 'gte':
        return `>=${value}`;
      case 'lt':
        return `<${value}`;
      case 'lte':
        return `<=${value}`;
      case 'between':
        return `${value}...${String(criterion.value2 ?? '')}`;
      case 'empty':
        return '=';
      case 'notEmpty':
        return '*';
      default:
        return value;
    }
  }

  /**
   * Best-effort reverse of criterionToFindValue. Any string maps to some
   * operator; plain values fall back to "matches" so nothing is lost.
   */
  function findValueToCriterion(field, raw) {
    const value = String(raw);
    const base = { field, operator: 'match', value, value2: '' };

    if (value === '=') {
      return { ...base, operator: 'empty', value: '' };
    }
    if (value === '*') {
      return { ...base, operator: 'notEmpty', value: '' };
    }
    if (value.startsWith('==')) {
      return { ...base, operator: 'equals', value: value.slice(2) };
    }
    if (value.startsWith('>=')) {
      return { ...base, operator: 'gte', value: value.slice(2) };
    }
    if (value.startsWith('<=')) {
      return { ...base, operator: 'lte', value: value.slice(2) };
    }
    if (value.startsWith('>')) {
      return { ...base, operator: 'gt', value: value.slice(1) };
    }
    if (value.startsWith('<')) {
      return { ...base, operator: 'lt', value: value.slice(1) };
    }
    const rangeIndex = value.indexOf('...');
    if (rangeIndex > 0 && rangeIndex < value.length - 3) {
      return {
        ...base,
        operator: 'between',
        value: value.slice(0, rangeIndex),
        value2: value.slice(rangeIndex + 3)
      };
    }
    if (value.length > 2 && value.startsWith('*') && value.endsWith('*')) {
      return { ...base, operator: 'contains', value: value.slice(1, -1) };
    }
    if (value.length > 1 && value.endsWith('*') && !value.startsWith('*')) {
      return { ...base, operator: 'begins', value: value.slice(0, -1) };
    }
    return base;
  }

  function createEmptyModel() {
    return {
      requests: [createEmptyRequest()],
      sort: []
    };
  }

  function createEmptyRequest() {
    return { omit: false, criteria: [{ field: '', operator: 'match', value: '', value2: '' }] };
  }

  /** Builds the find array. Criteria without a field are skipped. */
  function modelToFindQuery(model) {
    const requests = Array.isArray(model && model.requests) ? model.requests : [];
    const query = [];

    for (const request of requests) {
      const entry = {};
      for (const criterion of request.criteria || []) {
        const field = String(criterion.field || '').trim();
        if (!field) {
          continue;
        }
        entry[field] = criterionToFindValue(criterion);
      }
      if (Object.keys(entry).length === 0) {
        continue;
      }
      if (request.omit) {
        entry.omit = 'true';
      }
      query.push(entry);
    }

    // The Data API rejects an empty array; `[{}]` is not valid either, so a form
    // with no criteria yields an empty request the host validator reports clearly.
    return query.length > 0 ? query : [{}];
  }

  function modelToSort(model) {
    const sort = Array.isArray(model && model.sort) ? model.sort : [];
    return sort
      .filter((item) => String(item.fieldName || '').trim())
      .map((item) => ({
        fieldName: String(item.fieldName).trim(),
        sortOrder: item.sortOrder === 'descend' ? 'descend' : 'ascend'
      }));
  }

  /**
   * Parses find JSON (and optional sort JSON) text into a form model.
   * Returns { ok: false, reason } when the JSON can't be shown faithfully in
   * the form (non-string values, unknown keys, invalid JSON).
   */
  function jsonToModel(findText, sortText) {
    let find;
    try {
      find = JSON.parse(String(findText || '').trim() || '[{}]');
    } catch {
      return { ok: false, reason: 'Find JSON is not valid JSON.' };
    }
    if (!Array.isArray(find)) {
      return { ok: false, reason: 'Find JSON must be an array of requests.' };
    }

    const requests = [];
    for (const item of find) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: 'Each find request must be an object.' };
      }
      const request = { omit: false, criteria: [] };
      for (const [key, value] of Object.entries(item)) {
        if (key === 'omit') {
          request.omit = value === true || String(value).toLowerCase() === 'true';
          continue;
        }
        if (typeof value !== 'string' && typeof value !== 'number') {
          return { ok: false, reason: `Field "${key}" has a value the form can't show.` };
        }
        request.criteria.push(findValueToCriterion(key, value));
      }
      if (request.criteria.length === 0) {
        request.criteria.push({ field: '', operator: 'match', value: '', value2: '' });
      }
      requests.push(request);
    }

    let sort = [];
    const trimmedSort = String(sortText || '').trim();
    if (trimmedSort) {
      let parsedSort;
      try {
        parsedSort = JSON.parse(trimmedSort);
      } catch {
        return { ok: false, reason: 'Sort JSON is not valid JSON.' };
      }
      if (!Array.isArray(parsedSort)) {
        return { ok: false, reason: 'Sort JSON must be an array.' };
      }
      for (const item of parsedSort) {
        if (!item || typeof item !== 'object' || typeof item.fieldName !== 'string') {
          return { ok: false, reason: 'Each sort entry needs a fieldName.' };
        }
        const order = String(item.sortOrder || 'ascend').toLowerCase();
        if (order !== 'ascend' && order !== 'descend') {
          return { ok: false, reason: `Sort order "${item.sortOrder}" can't be shown in the form.` };
        }
        sort.push({ fieldName: item.fieldName, sortOrder: order });
      }
    }

    return {
      ok: true,
      model: { requests: requests.length > 0 ? requests : [createEmptyRequest()], sort }
    };
  }

  return {
    OPERATORS,
    OPERATOR_IDS,
    getOperator,
    criterionToFindValue,
    findValueToCriterion,
    createEmptyModel,
    createEmptyRequest,
    modelToFindQuery,
    modelToSort,
    jsonToModel
  };
});
