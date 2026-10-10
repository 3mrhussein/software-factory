// React + htm glue: JSX-like templates with no build step.
const { React, ReactDOM, htm } = window;

export const html = htm.bind(React.createElement);
export const { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect, Fragment, memo } = React;
export { React, ReactDOM };
