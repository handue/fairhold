import { Fragment } from "react";

import { formatUsd } from "./format";

/**
 * An amount set in Geist Mono. Mono gives the thousands comma a full cell, so every approved
 * screen pulls it in by .12em on each side ("$6,840", "$1,000"). Amounts in running sans text
 * use formatUsd directly.
 */
export function Money({ cents }: { cents: number }) {
  return formatUsd(cents)
    .split(",")
    .map((group, index) => (
      <Fragment key={index}>
        {index > 0 && <span className="mx-[-.12em]">,</span>}
        {group}
      </Fragment>
    ));
}
