import next from "eslint-config-next";

const config = [
  ...next,
  {
    // The project uses setState-in-effect patterns that predate the
    // react-hooks v5 `set-state-in-effect` rule. Keep them as warnings rather
    // than errors so `npm run lint` stays green without rewriting components.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    ignores: [".next/**", "out/**", "build/**", "node_modules/**"],
  },
];

export default config;
