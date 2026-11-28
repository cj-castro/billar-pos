"""Test double for ops.Runner. Records every call; never runs anything."""


class FakeRunner:
    """Stands in for ops.Runner.

    `responses` maps a key to a response. A key matches a call when it equals
    the first 3 args joined by a space (the generic key), or when it appears
    anywhere in the full joined command line. A key that matched inside the
    command beats the generic key (it is more specific); among those, the
    longest wins. A response is one of:
      - (exit_code, output)
      - a list of those, used in order (the last one repeats)
      - a callable fn(args, **kwargs) -> (exit_code, output)
    No match -> (0, '').

    `calls` holds one dict per call: args, stdout_path, input_path,
    input_text, env, timeout, stderr. A callable response can look at
    kwargs['stderr'] to imitate what the real Runner returns with
    stderr='separate' (stdout only) versus the default (combined).
    """

    def __init__(self, responses=None):
        self.responses = dict(responses or {})
        self.calls = []

    def run(self, args, *, stdout_path=None, input_path=None, input_text=None,
            env=None, timeout=600, stderr=None):
        args = [str(a) for a in args]
        kwargs = {"stdout_path": stdout_path, "input_path": input_path,
                  "input_text": input_text, "env": env, "timeout": timeout,
                  "stderr": stderr}
        self.calls.append(dict(args=args, **kwargs))
        resp = self._lookup(args)
        if resp is None:
            return 0, ""
        if callable(resp):
            return resp(args, **kwargs)
        return resp

    def _lookup(self, args):
        joined = " ".join(args)
        key3 = " ".join(args[:3])
        matches = [k for k in self.responses if k == key3 or k in joined]
        if not matches:
            return None
        key = max(matches, key=lambda k: (k != key3, len(k)))
        resp = self.responses[key]
        if isinstance(resp, list):
            if not resp:
                return None
            return resp.pop(0) if len(resp) > 1 else resp[0]
        return resp

    def commands(self):
        """Every call as one joined string, in order."""
        return [" ".join(c["args"]) for c in self.calls]
