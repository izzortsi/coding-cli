#!/usr/bin/env python3
"""
Thin bridge between grove-cli (TypeScript) and anthropic-oauth (Python).

Commands:
  status  - JSON: {authenticated, expired}
  token   - stdout: access_token (auto-refreshes)
  login   - interactive OAuth flow
  logout  - clear tokens

Exit codes: 0=success, 1=not authenticated, 2=refresh failed, 3=unexpected error
"""
import sys
import json

try:
    from anthropic_oauth import OAuthManager
except ImportError:
    print("anthropic-oauth not installed. Run: pip install anthropic-oauth", file=sys.stderr)
    sys.exit(3)

def main():
    if len(sys.argv) < 2:
        print("Usage: auth_bridge.py <status|token|login|logout>", file=sys.stderr)
        sys.exit(3)

    cmd = sys.argv[1]
    manager = OAuthManager()

    if cmd == "status":
        tokens = manager.get_tokens()
        if tokens is None:
            print(json.dumps({"authenticated": False, "expired": False}))
            sys.exit(1)
        print(json.dumps({"authenticated": True, "expired": tokens.is_expired()}))

    elif cmd == "token":
        tokens = manager.get_tokens()
        if tokens is None:
            sys.exit(1)
        try:
            access = manager.get_access_token()
            print(access, end="")
        except Exception as e:
            print(str(e), file=sys.stderr)
            sys.exit(2)

    elif cmd == "login":
        from anthropic_oauth import interactive_auth
        interactive_auth(manager)

    elif cmd == "logout":
        manager.clear_tokens()
        print("Tokens cleared.")

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(3)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(3)
