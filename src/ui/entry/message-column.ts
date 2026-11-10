/**
 * 16c's centred column below 1440, shared by 16c, 16b and the not-found pages. At 1024 and up the
 * 880px column is as drawn. Below 1024 it takes the width less the gutters (32px, 16 on a phone),
 * and MESSAGE_TOP starts it higher. On a phone the 34px title steps down to 26px, balanced when it wraps.
 */
export const MESSAGE_COLUMN = "max-lg:w-full max-lg:px-32 max-md:px-16";
export const MESSAGE_TOP = "max-lg:pt-160 max-md:pt-72";
export const MESSAGE_TITLE = "max-md:text-26 max-md:leading-32 max-md:text-balance";
