"""String formatting utilities."""


def capitalize(text: str) -> str:
    if not text:
        return text
    return text[0].upper() + text[1:]


def format_template(template: str, *args) -> str:
    return template % args
