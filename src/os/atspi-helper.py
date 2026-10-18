#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Claude Anywhere AT-SPI helper (docs/ARCHITECTURE.md section 4, Linux UI automation).

src/os/linux.js runs it as `python3 -I atspi-helper.py`: one JSON request on stdin, one JSON
answer on stdout, then the process exits. It reads and drives the accessibility tree of any
AT-SPI application (GTK, Qt with accessibility on, Chromium/Electron with renderer accessibility,
Firefox, LibreOffice, Java with the ATK wrapper) through gi.repository.Atspi.

Requests ({"cmd": ...}):
  version                          protocol version (no AT-SPI needed)
  roles   {items:[{role, states?}]} shared roles for AT-SPI role names (no AT-SPI needed)
  match   {items:[str], query, exact} match scores (no AT-SPI needed)
  probe                            bindings and accessibility bus check, number of applications
  tree    {window, depth, maxNodes, budgetMs, origin?}
  find    {window, name?, text?, roles?, exact?, limit?, maxNodes?, depth?, budgetMs?, origin?}
  action  {window, root, path, hash, action, value?, origin?}
  window: {pid?, title?, app?, bounds?, index?, active?} picks the top-level window: the same
          process and title (and nearly the same bounds), else the active one.
  origin: {x, y}: report bounds as window-relative extents plus this origin (Wayland, where
          screen coordinates are not known to applications); otherwise screen coordinates.

Answers: {"ok": true, ...} or {"ok": false, "code": CODE, "error": text}; CODE is one of
NO_BINDINGS (python3-gi / the Atspi typelib missing), NO_BUS (no session or accessibility bus),
NO_WINDOW (the window is not in the accessibility tree), STALE (the element is gone),
BAD_REQUEST, ERROR. Element references are "<root>:<child indices>:<hash>", root "w" for the
window or "p<k>" for a pop-up (the application's k-th child); the hash covers role and name.

Written for Python 3.6+ and the standard library plus PyGObject; it never installs anything.
"""

import hashlib
import json
import os
import sys
import time
import warnings
from collections import deque

# PyGObject flags deprecated libatspi calls; they must never reach stderr as noise.
warnings.simplefilter('ignore')

PROTOCOL = 1
MAX_NAME = 300
MAX_VALUE = 500
MAX_TEXT_READ = 4000
MAX_CHILDREN = 1500
RAW_DEPTH_MAX = 80
OBJ_CHAR = u'￼'
DEFAULT_BUDGET_MS = 6000
MAX_BUDGET_MS = 30000
METHOD_TIMEOUT_MS = 1500
STARTUP_TIMEOUT_MS = 3000

SHARED_ROLES = (
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listitem', 'menuitem', 'menu', 'tab',
    'tablist', 'treeitem', 'image', 'text', 'heading', 'window', 'toolbar', 'group', 'table', 'row', 'cell',
    'slider', 'other',
)

# AT-SPI role names (atspi_role_get_name) -> the shared vocabulary.
ROLE_MAP = {
    'push button': 'button', 'toggle button': 'button', 'button': 'button', 'push button menu': 'button',
    'link': 'link',
    'entry': 'textbox', 'password text': 'textbox', 'editbar': 'textbox', 'terminal': 'textbox',
    'check box': 'checkbox', 'switch': 'checkbox',
    'radio button': 'radio',
    'combo box': 'combobox', 'autocomplete': 'combobox',
    'list item': 'listitem',
    'menu item': 'menuitem', 'check menu item': 'menuitem', 'radio menu item': 'menuitem',
    'tearoff menu item': 'menuitem',
    'menu': 'menu', 'menu bar': 'menu', 'popup menu': 'menu',
    'page tab': 'tab', 'page tab list': 'tablist',
    'tree item': 'treeitem',
    'image': 'image', 'icon': 'image', 'image map': 'image', 'animation': 'image',
    'label': 'text', 'static': 'text', 'paragraph': 'text', 'caption': 'text', 'accelerator label': 'text',
    'text': 'text', 'tool tip': 'text', 'description term': 'text', 'description value': 'text',
    'footnote': 'text', 'subscript': 'text', 'superscript': 'text', 'mark': 'text', 'comment': 'text',
    'content deletion': 'text', 'content insertion': 'text', 'suggestion': 'text', 'rich text': 'text',
    'heading': 'heading',
    'frame': 'window', 'window': 'window', 'dialog': 'window', 'alert': 'window', 'file chooser': 'window',
    'color chooser': 'window', 'font chooser': 'window', 'internal frame': 'window',
    'tool bar': 'toolbar',
    'table': 'table', 'tree table': 'table',
    'table row': 'row',
    'table cell': 'cell', 'column header': 'cell', 'row header': 'cell', 'table column header': 'cell',
    'table row header': 'cell',
    'slider': 'slider', 'spin button': 'slider', 'dial': 'slider',
    'panel': 'group', 'filler': 'group', 'section': 'group', 'grouping': 'group', 'form': 'group',
    'landmark': 'group', 'article': 'group', 'split pane': 'group', 'scroll pane': 'group', 'viewport': 'group',
    'layered pane': 'group', 'root pane': 'group', 'glass pane': 'group', 'option pane': 'group',
    'desktop frame': 'group', 'list': 'group', 'list box': 'group', 'tree': 'group', 'status bar': 'group',
    'document web': 'group', 'document frame': 'group', 'document text': 'group',
    'document spreadsheet': 'group', 'document presentation': 'group', 'document email': 'group',
    'embedded': 'group', 'application': 'group', 'page': 'group', 'block quote': 'group',
    'directory pane': 'group', 'header': 'group', 'footer': 'group', 'info bar': 'group', 'log': 'group',
    'marquee': 'group', 'timer': 'group', 'description list': 'group', 'math': 'group',
    'notification': 'group', 'video': 'group', 'audio': 'group', 'redundant object': 'group',
    'html container': 'group', 'definition': 'group', 'calendar': 'group', 'date editor': 'group',
}
# Containers that take typed text when editable (contenteditable, rich-text editors, GtkTextView).
EDITABLE_CONTAINERS = {'text', 'document web', 'document frame', 'document text', 'section', 'paragraph',
                       'panel', 'rich text', 'document email', 'html container'}
INTERACTIVE = {'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listitem', 'menuitem', 'tab',
               'treeitem', 'slider', 'cell'}
# Default-action names in order of preference for "press".
PRESS_ACTIONS = ('click', 'press', 'activate', 'jump', 'toggle', 'open', 'invoke', 'select', 'clickancestor')
EXPAND_ACTIONS = ('expand or contract', 'expand', 'collapse', 'toggle', 'open', 'press', 'click')
MENU_ACTIONS = ('showmenu', 'show menu', 'menu', 'popup', 'context menu', 'show context menu')
NON_DEFAULT_ACTIONS = set(EXPAND_ACTIONS[:3]) | set(MENU_ACTIONS)
ACTIONS = ('press', 'focus', 'setValue', 'select', 'expand', 'collapse', 'scrollIntoView', 'showMenu')
CHROMIUM_TOOLKITS = ('chromium', 'chrome', 'electron')
# Per request: whether an unnamed container's own text is read as its value. Chromium exposes text
# runs as child objects already (reading the parent too would list every text twice); Gecko and
# most toolkits keep them in the parent's Text interface only.
OPTIONS = {'group_text': True}


class HelperError(Exception):
    def __init__(self, code, message, **extra):
        Exception.__init__(self, message)
        self.code = code
        self.extra = extra


# ---------------------------------------------------------------------------- pure helpers

def norm(s):
    """Lower-case (casefold) with whitespace collapsed; '' for None."""
    return ' '.join(str(s if s is not None else '').split()).casefold()


def clip(s, n):
    s = str(s if s is not None else '')
    return s if len(s) <= n else s[:n - 1] + u'…'


def clean_text(s):
    """Text content without embedded-object characters, whitespace collapsed."""
    return ' '.join(str(s if s is not None else '').replace(OBJ_CHAR, ' ').split())


def shared_role(role_name, states=(), editable=False):
    """The shared role for an AT-SPI role name; editable text containers count as text boxes."""
    r = ' '.join(str(role_name or '').lower().replace('_', ' ').split())
    if editable and r in EDITABLE_CONTAINERS and ('focusable' in states or 'focused' in states or r == 'text'):
        return 'textbox'
    return ROLE_MAP.get(r, 'other')


def match_score(haystack, query, exact=False):
    """3 = whole text, 2 = prefix, 1 = substring (case-insensitive), 0 = no match."""
    h = norm(haystack)
    q = norm(query)
    if not q or not h:
        return 0
    if h == q:
        return 3
    if exact:
        return 0
    if h.startswith(q):
        return 2
    if q in h:
        return 1
    return 0


def node_hash(role, name):
    data = (role + u'\u0000' + clip(name, MAX_NAME)).encode('utf-8', 'replace')
    return hashlib.sha1(data).hexdigest()[:6]


def make_ref(root, path, role, name):
    return '%s:%s:%s' % (root, '.'.join(str(i) for i in path), node_hash(role, name))


def num_text(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if f != f:
        return ''
    if f == int(f) and abs(f) < 1e15:
        return str(int(f))
    return ('%.6g' % f)


def clamp_int(v, lo, hi, default):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


# ---------------------------------------------------------------------------- AT-SPI access

Atspi = None
GLib = None


def safe(fn, default=None):
    try:
        return fn()
    except Exception:  # GLib.Error (D-Bus), TypeError on defunct objects
        return default


def load_bindings():
    global Atspi, GLib
    try:
        import gi
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi as _Atspi
        from gi.repository import GLib as _GLib
    except Exception as e:  # ImportError, ValueError (typelib missing)
        raise HelperError('NO_BINDINGS', 'The AT-SPI Python bindings are not available: %s' % e,
                          python=sys.version.split()[0], executable=sys.executable)
    Atspi = _Atspi
    GLib = _GLib


def check_bus():
    """Make sure the accessibility bus is reachable before libatspi touches it (it aborts if not)."""
    from gi.repository import Gio
    addr = os.environ.get('AT_SPI_BUS_ADDRESS')
    if addr:
        try:
            conn = Gio.DBusConnection.new_for_address_sync(
                addr, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                None, None)
            conn.close_sync(None)
            return
        except Exception as e:
            raise HelperError('NO_BUS', 'AT_SPI_BUS_ADDRESS is set but the accessibility bus does not answer: %s' % e)
    if not os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
        runtime = os.environ.get('XDG_RUNTIME_DIR')
        sock = os.path.join(runtime, 'bus') if runtime else ''
        if not sock or not os.path.exists(sock):
            raise HelperError('NO_BUS', 'No D-Bus session bus: DBUS_SESSION_BUS_ADDRESS is not set')
        os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + sock
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        bus.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', None,
                      GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None)
    except Exception as e:
        raise HelperError('NO_BUS', 'The accessibility bus (at-spi-bus-launcher) is not available: %s' % e)


def init_atspi():
    load_bindings()
    check_bus()
    Atspi.init()
    if hasattr(Atspi, 'set_timeout'):
        Atspi.set_timeout(METHOD_TIMEOUT_MS, STARTUP_TIMEOUT_MS)
    return Atspi.get_desktop(0)


def state_names(acc):
    ss = safe(acc.get_state_set)
    if ss is None:
        return set()
    states = safe(ss.get_states, []) or []
    out = set()
    for s in states:
        nick = getattr(s, 'value_nick', None)
        if nick:
            out.add(nick)
    return out


def role_name_of(acc):
    role = safe(acc.get_role)
    name = None
    if role is not None:
        name = safe(lambda: Atspi.role_get_name(role))
    if not name:
        name = safe(acc.get_role_name, '')
    return name or ''


def children_of(acc, cap=MAX_CHILDREN):
    n = safe(acc.get_child_count, 0) or 0
    out = []
    for i in range(min(max(n, 0), cap)):
        c = safe(lambda: acc.get_child_at_index(i))
        if c is not None:
            out.append((i, c))
    return out


def read_text(acc, limit):
    n = safe(lambda: Atspi.Text.get_character_count(acc), 0) or 0
    if n <= 0:
        return ''
    t = safe(lambda: Atspi.Text.get_text(acc, 0, min(n, limit)), '')
    return t or ''


class Coords(object):
    """Screen coordinates, or window-relative ones plus an origin, times a toolkit scale factor."""

    def __init__(self, origin=None):
        self.origin = None
        if isinstance(origin, dict) and 'x' in origin and 'y' in origin:
            try:
                self.origin = (float(origin['x']), float(origin['y']))
            except (TypeError, ValueError):
                self.origin = None
        self.scale = 1.0

    def extents(self, acc):
        kind = Atspi.CoordType.WINDOW if self.origin else Atspi.CoordType.SCREEN
        r = safe(lambda: Atspi.Component.get_extents(acc, kind))
        if r is None:
            return None
        x, y, w, h = r.x, r.y, r.width, r.height
        if w < 0 or h < 0 or x <= -(1 << 30) or y <= -(1 << 30):
            return None
        if self.origin:
            x += self.origin[0]
            y += self.origin[1]
        k = self.scale
        return {'x': int(round(x * k)), 'y': int(round(y * k)), 'width': int(round(w * k)), 'height': int(round(h * k))}


class Node(object):
    """What one accessible object looks like to the model (read lazily, a few D-Bus calls each)."""

    __slots__ = ('acc', 'role_name', 'role', 'name', 'states', 'ifaces', 'editable', 'visible', 'value', 'own_text', '_bounds')

    def __init__(self, acc):
        self.acc = acc
        self.role_name = role_name_of(acc)
        self.states = state_names(acc)
        self.ifaces = set(safe(acc.get_interfaces, []) or [])
        self.editable = 'editable' in self.states and ('EditableText' in self.ifaces or 'Text' in self.ifaces)
        self.role = shared_role(self.role_name, self.states, self.editable)
        name = safe(acc.get_name, '') or ''
        self.own_text = None
        if not name.strip() and self.role == 'text' and 'Text' in self.ifaces:
            # Static text often has its content only in the Text interface.
            self.own_text = clean_text(read_text(acc, MAX_TEXT_READ))
            name = self.own_text
        self.name = clip(' '.join(name.split()), MAX_NAME)
        states = self.states
        self.visible = bool(not states or 'visible' in states or 'showing' in states)
        self.value = None
        self._bounds = False

    def bounds(self, coords):
        """Extents (cached), or None without the Component interface."""
        if self._bounds is False:
            self._bounds = coords.extents(self.acc) if 'Component' in self.ifaces else None
        return self._bounds

    def zero_size(self, coords):
        """Has a frame of no size at all: hidden (a toolbar icon not in use, a collapsed region)."""
        b = self.bounds(coords)
        return bool(b) and b['width'] == 0 and b['height'] == 0

    @property
    def defunct(self):
        return 'defunct' in self.states

    @property
    def enabled(self):
        return not self.states or 'enabled' in self.states or 'sensitive' in self.states

    @property
    def hidden_secret(self):
        return self.role_name == 'password text'

    def text_value(self):
        """The value to show: text of an edit box or combo box, a slider's number, a group's own text."""
        if self.value is not None:
            return self.value
        v = ''
        acc = self.acc
        if self.hidden_secret:
            v = ''
        elif 'Value' in self.ifaces and self.role in ('slider', 'other', 'textbox', 'combobox'):
            cur = safe(lambda: Atspi.Value.get_current_value(acc))
            if cur is not None:
                v = num_text(cur)
        if not v and not self.hidden_secret and 'Text' in self.ifaces and self.role in ('textbox', 'combobox'):
            v = read_text(acc, MAX_TEXT_READ).replace(OBJ_CHAR, '')
        if not v and self.role == 'group' and not self.name and OPTIONS['group_text'] and 'Text' in self.ifaces:
            v = clean_text(read_text(acc, MAX_TEXT_READ))
        self.value = clip(v, MAX_VALUE)
        return self.value

    def description(self):
        return clip(' '.join((safe(self.acc.get_description, '') or '').split()), MAX_NAME)

    def record(self, coords, ref, full=True):
        out = {'ref': ref, 'role': self.role, 'name': self.name, 'atspiRole': self.role_name}
        states = self.states
        if full:
            v = self.text_value()
            if v:
                out['value'] = v
            d = self.description()
            if d and d != self.name:
                out['description'] = d
        b = self.bounds(coords)
        out['bounds'] = b or {'x': 0, 'y': 0, 'width': 0, 'height': 0}
        out['enabled'] = self.enabled
        out['focused'] = 'focused' in states
        if 'selectable' in states or 'selected' in states:
            out['selected'] = 'selected' in states
        if self.role in ('checkbox', 'radio') or 'checkable' in states or 'checked' in states:
            out['checked'] = 'mixed' if 'indeterminate' in states else ('checked' in states)
        elif self.role_name == 'toggle button':
            out['checked'] = 'pressed' in states or 'checked' in states
        if 'expandable' in states or 'expanded' in states:
            out['expanded'] = 'expanded' in states
        if self.editable:
            out['editable'] = True
        if (states and 'showing' not in states) or self.zero_size(coords):
            out['offscreen'] = True
        return out


# ---------------------------------------------------------------------------- windows

def window_bounds(acc, coords):
    return coords.extents(acc)


def list_candidates(desktop, coords):
    out = []
    for ai, app in children_of(desktop, 400):
        pid = safe(app.get_process_id, 0) or 0
        app_name = safe(app.get_name, '') or ''
        toolkit = safe(app.get_toolkit_name, '') or ''
        for wi, w in children_of(app, 200):
            states = state_names(w)
            if 'defunct' in states:
                continue
            out.append({
                'app': app, 'appIndex': ai, 'pid': pid, 'appName': app_name, 'toolkit': toolkit,
                'acc': w, 'index': wi, 'title': safe(w.get_name, '') or '', 'role': role_name_of(w),
                'states': states, 'bounds': window_bounds(w, coords),
            })
    return out


def close_bounds(a, b, tol=80):
    if not a or not b:
        return False
    try:
        return (abs(a['x'] - b['x']) <= tol and abs(a['y'] - b['y']) <= tol and
                abs(a['width'] - b['width']) <= tol and abs(a['height'] - b['height']) <= tol)
    except (KeyError, TypeError):
        return False


def overlap_area(a, b):
    if not a or not b:
        return 0
    try:
        w = min(a['x'] + a['width'], b['x'] + b['width']) - max(a['x'], b['x'])
        h = min(a['y'] + a['height'], b['y'] + b['height']) - max(a['y'], b['y'])
    except (KeyError, TypeError):
        return 0
    return w * h if w > 0 and h > 0 else 0


def is_popup(c):
    return c['role'] in ('window', 'menu', 'popup menu', 'tool tip') and not c['title'].strip()


def score_window(c, ref):
    s = 0
    title = norm(ref.get('title'))
    ct = norm(c['title'])
    if title and ct:
        if ct == title:
            s += 60
        elif ct in title or title in ct:
            s += 25
    b = ref.get('bounds')
    if b and c['bounds']:
        if close_bounds(c['bounds'], b):
            s += 20
        elif overlap_area(c['bounds'], b) > 0:
            s += 5
    if 'active' in c['states']:
        s += 40 if ref.get('active') else 8
    if 'showing' in c['states'] or 'visible' in c['states']:
        s += 2
    if is_popup(c):
        s -= 30
    idx = ref.get('index')
    if isinstance(idx, int) and idx == c['index']:
        s += 10
    return s


def pick_window(desktop, ref, coords):
    """The accessible top-level window for a window reference, and the app's showing pop-ups."""
    cands = list_candidates(desktop, coords)
    if not cands:
        raise HelperError('NO_WINDOW', 'No application is registered on the accessibility bus.', apps=0)
    pid = ref.get('pid') or 0
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        pid = 0
    pool = [c for c in cands if pid and c['pid'] == pid]
    by_pid = bool(pool)
    if not pool:
        pool = cands
    scored = sorted(((score_window(c, ref), -c['appIndex'], -c['index'], i) for i, c in enumerate(pool)), reverse=True)
    best_score, _, _, best_i = scored[0]
    best = pool[best_i]
    if not by_pid:
        title_ok = bool(norm(ref.get('title'))) and match_score(best['title'], ref.get('title')) >= 1 and best_score >= 25
        active_ok = (ref.get('active') or not ref.get('title')) and 'active' in best['states'] and not pid
        if not (title_ok or active_ok):
            raise HelperError('NO_WINDOW', 'The window is not in the accessibility tree.', apps=len({c['appIndex'] for c in cands}))
    popups = []
    for c in cands:
        if c['appIndex'] == best['appIndex'] and c['index'] != best['index'] and is_popup(c) and 'showing' in c['states']:
            popups.append(c)
    return best, popups[:6]


def window_info(c):
    return {'pid': c['pid'], 'app': c['appName'], 'title': c['title'], 'index': c['index'],
            'toolkit': c['toolkit'], 'bounds': c['bounds']}


def apply_scale(coords, c, ref):
    """X11 HiDPI (GDK_SCALE): toolkit coordinates are logical; scale them to the X window's size."""
    b = ref.get('bounds')
    cb = c['bounds']
    if coords.origin or not b or not cb or cb['width'] <= 0 or cb['height'] <= 0:
        return
    try:
        kx = float(b['width']) / cb['width']
        ky = float(b['height']) / cb['height']
    except (KeyError, TypeError, ZeroDivisionError):
        return
    if 1.4 <= kx <= 3.2 and 1.4 <= ky <= 3.2 and abs(kx - ky) < 0.15:
        coords.scale = (kx + ky) / 2.0
        c['bounds'] = coords.extents(c['acc'])


def chromium_like(c):
    tk = norm(c.get('toolkit'))
    app = norm(c.get('appName'))
    return any(k in tk for k in CHROMIUM_TOOLKITS) or any(k in app for k in ('chrom', 'brave', 'electron', 'edge', 'vivaldi', 'opera'))


# ---------------------------------------------------------------------------- walks

def roots_for(win, popups):
    roots = [('w', win['acc'])]
    for p in popups:
        roots.append(('p%d' % p['index'], p['acc']))
    return roots


def cmd_tree(req, desktop):
    coords = Coords(req.get('origin'))
    ref = req.get('window') or {}
    win, popups = pick_window(desktop, ref, coords)
    apply_scale(coords, win, ref)
    OPTIONS['group_text'] = not chromium_like(win)
    depth = clamp_int(req.get('depth'), 0, 50, 6)
    max_nodes = clamp_int(req.get('maxNodes'), 1, 5000, 400)
    budget = clamp_int(req.get('budgetMs'), 200, MAX_BUDGET_MS, DEFAULT_BUDGET_MS)
    deadline = time.monotonic() + budget / 1000.0

    nodes = []
    by_ref = {}
    truncated = False
    scanned = 0
    saw_document = False
    queue = deque()
    for tag, acc in roots_for(win, popups):
        # (accessible, root tag, path, listed parent ref, listed depth, raw depth, listed parent name, is root)
        queue.append((acc, tag, (), None, 0, 0, '', True))
    while queue:
        if time.monotonic() > deadline or len(nodes) >= max_nodes:
            truncated = True
            break
        acc, tag, path, pref, ldepth, rdepth, pname, is_root = queue.popleft()
        n = Node(acc)
        scanned += 1
        if n.defunct or (not is_root and not n.visible):
            continue
        if n.role_name.startswith('document'):
            saw_document = True
        listed = is_root or (listable(n, pname) and not n.zero_size(coords))
        child_pref, child_depth, child_pname = pref, ldepth, pname
        if listed:
            rec = n.record(coords, make_ref(tag, path, n.role, n.name))
            rec['parent'] = pref
            rec['children'] = []
            rec['depth'] = ldepth
            rec['_key'] = (tag != 'w', tag, path)
            nodes.append(rec)
            by_ref[rec['ref']] = rec
            if pref is not None and pref in by_ref:
                by_ref[pref]['children'].append(rec['ref'])
            if ldepth >= depth:
                if (safe(acc.get_child_count, 0) or 0) > 0:
                    rec['more'] = True
                continue
            child_pref, child_depth, child_pname = rec['ref'], ldepth + 1, n.name or rec.get('value', '')
        if rdepth >= RAW_DEPTH_MAX:
            continue
        manages = 'manages-descendants' in n.states
        for i, c in children_of(acc):
            if manages and 'showing' not in state_names(c):
                continue
            queue.append((c, tag, path + (i,), child_pref, child_depth, rdepth + 1, child_pname, False))
    if queue and not truncated:
        truncated = True
    # Document order: sort children by their paths (BFS visits a passed-through group's children late).
    keys = {r['ref']: r['_key'] for r in nodes}
    for r in nodes:
        r['children'].sort(key=lambda k: keys.get(k, (True, '', ())))
    ordered = []
    roots = [r for r in nodes if r['parent'] is None]
    roots.sort(key=lambda r: r['_key'])
    stack = list(reversed(roots))
    while stack:
        r = stack.pop()
        ordered.append(r)
        for k in reversed(r['children']):
            if k in by_ref:
                stack.append(by_ref[k])
    for r in ordered:
        del r['_key']
    out = {'ok': True, 'window': window_info(win), 'nodes': ordered, 'truncated': truncated, 'scanned': scanned}
    notes = tree_notes(win, len(ordered), saw_document)
    if notes:
        out['notes'] = notes
    if coords.scale != 1.0:
        out['scale'] = round(coords.scale, 3)
    return out


def listable(n, parent_name):
    """Whether a tree node is listed (unnamed containers and repeated labels are walked through)."""
    role = n.role
    name = n.name
    if role in ('group', 'other'):
        if name:
            return True
        if 'focusable' in n.states and 'Action' in n.ifaces:
            return True
        return bool(n.text_value()) if role == 'group' else False
    if role == 'text':
        return bool(name) and norm(name) != norm(parent_name)
    if role == 'image':
        return bool(name)
    return True


def tree_notes(win, count, saw_document):
    notes = []
    if chromium_like(win) and not saw_document and count < 25:
        notes.append(
            'This Chromium-based window shows no web content to accessibility. Quit the browser or '
            'Electron app and start it with --force-renderer-accessibility (and ACCESSIBILITY_ENABLED=1 in '
            'its environment), or use find_text (OCR) or a screenshot.')
    elif count <= 2:
        notes.append(
            'This window exposes almost nothing to accessibility (the app may draw its own UI): use '
            'find_text (OCR) or a screenshot instead.')
    return notes


def cmd_find(req, desktop):
    coords = Coords(req.get('origin'))
    ref = req.get('window') or {}
    win, popups = pick_window(desktop, ref, coords)
    apply_scale(coords, win, ref)
    OPTIONS['group_text'] = not chromium_like(win)
    name_q = str(req.get('name') or '').strip()
    text_q = str(req.get('text') or '').strip()
    roles = [r for r in (req.get('roles') or []) if r in SHARED_ROLES]
    if not name_q and not text_q and not roles:
        raise HelperError('BAD_REQUEST', 'find needs a name, text or roles')
    exact = bool(req.get('exact'))
    limit = clamp_int(req.get('limit'), 1, 200, 20)
    max_scan = clamp_int(req.get('maxNodes'), 1, 50000, 8000)
    max_depth = clamp_int(req.get('depth'), 1, RAW_DEPTH_MAX, 60)
    budget = clamp_int(req.get('budgetMs'), 200, MAX_BUDGET_MS, DEFAULT_BUDGET_MS)
    deadline = time.monotonic() + budget / 1000.0

    matches = []
    truncated = False
    scanned = 0
    saw_document = False
    queue = deque()
    # Open menus and drop-downs first: what the user just opened is what they are after.
    roots = roots_for(win, popups)
    roots = roots[1:] + roots[:1]
    for tag, acc in roots:
        queue.append((acc, tag, (), 0, ''))
    order = 0
    while queue:
        if time.monotonic() > deadline or scanned >= max_scan:
            truncated = True
            break
        acc, tag, path, rdepth, matched_name = queue.popleft()
        n = Node(acc)
        scanned += 1
        if n.defunct or (path and not n.visible):
            continue
        if n.role_name.startswith('document'):
            saw_document = True
        score = 0
        ok_role = not roles or n.role in roles
        if ok_role:
            ns = match_score(n.name, name_q, exact) if name_q else 0
            ts = 0
            if text_q:
                ts = max(match_score(n.name, text_q, exact), match_score(n.text_value(), text_q, exact),
                         match_score(n.description(), text_q, exact))
            if (not name_q or ns) and (not text_q or ts):
                score = ns + ts if (name_q or text_q) else 1
            # A label that repeats the name of a matched control is the same thing.
            if score and n.role == 'text' and matched_name and norm(n.name) == norm(matched_name):
                score = 0
        next_matched = matched_name
        if score:
            rec = n.record(coords, make_ref(tag, path, n.role, n.name))
            rec['path'] = '%s:%s' % (tag, '.'.join(str(i) for i in path))
            rec['_sort'] = (-score, 0 if n.role in INTERACTIVE else 1, 1 if rec.get('offscreen') else 0,
                            0 if rec['enabled'] else 1, order)
            order += 1
            matches.append(rec)
            next_matched = n.name or rec.get('value', '')
        if rdepth >= max_depth:
            continue
        manages = 'manages-descendants' in n.states
        for i, c in children_of(acc):
            if manages and 'showing' not in state_names(c):
                continue
            queue.append((c, tag, path + (i,), rdepth + 1, next_matched))
    if queue and not truncated:
        truncated = True
    matches.sort(key=lambda r: r['_sort'])
    out_matches = []
    for r in matches[:limit]:
        del r['_sort']
        out_matches.append(r)
    out = {'ok': True, 'window': window_info(win), 'matches': out_matches, 'truncated': truncated,
           'scanned': scanned, 'total': len(matches)}
    notes = []
    if not matches:
        notes = tree_notes(win, 0 if not saw_document and chromium_like(win) else 99, saw_document)
    if notes:
        out['notes'] = notes
    if coords.scale != 1.0:
        out['scale'] = round(coords.scale, 3)
    return out


# ---------------------------------------------------------------------------- actions

def follow(root, path):
    acc = root
    for i in path:
        n = safe(acc.get_child_count, 0) or 0
        if i < 0 or i >= n:
            return None
        acc = safe(lambda: acc.get_child_at_index(i))
        if acc is None:
            return None
    return acc


def resolve(root, path, want_hash, deadline):
    """The element at path when its role and name still match, else the nearest one that does."""
    acc = follow(root, path)
    if acc is not None:
        n = Node(acc)
        if not n.defunct and node_hash(n.role, n.name) == want_hash:
            return n, path, 'path'
    best = None
    best_common = -1
    queue = deque([(root, ())])
    scanned = 0
    while queue and scanned < 6000 and time.monotonic() < deadline:
        acc, p = queue.popleft()
        n = Node(acc)
        scanned += 1
        if n.defunct:
            continue
        if node_hash(n.role, n.name) == want_hash:
            common = 0
            for a, b in zip(p, path):
                if a != b:
                    break
                common += 1
            if common > best_common:
                best, best_common = (n, p), common
        if len(p) < RAW_DEPTH_MAX:
            for i, c in children_of(acc):
                queue.append((c, p + (i,)))
    if best:
        return best[0], best[1], 'moved'
    return None, None, None


def action_names(acc):
    n = safe(lambda: Atspi.Action.get_n_actions(acc), 0) or 0
    return [(safe(lambda: Atspi.Action.get_action_name(acc, i), '') or '').strip().lower() for i in range(max(n, 0))]


def pick_action(names, wanted, allow_first=False):
    for w in wanted:
        for i, nm in enumerate(names):
            if nm == w:
                return i
    for w in wanted:
        for i, nm in enumerate(names):
            if w in nm:
                return i
    if allow_first and names and names[0] not in NON_DEFAULT_ACTIONS:
        return 0
    return -1


def run_action(acc, index):
    """do_action; a call that times out usually opened a modal dialog: report it as pending."""
    try:
        return bool(Atspi.Action.do_action(acc, index)), False
    except Exception as e:
        msg = str(e)
        if 'imeout' in msg or 'NoReply' in msg or 'timed out' in msg:
            return True, True
        raise


def select_via_parent(n):
    parent = safe(n.acc.get_parent)
    if parent is None:
        return False
    if 'Selection' not in set(safe(parent.get_interfaces, []) or []):
        return False
    idx = safe(n.acc.get_index_in_parent, -1)
    if idx is None or idx < 0:
        return False
    return bool(safe(lambda: Atspi.Selection.select_child(parent, idx), False))


def press(n):
    if not n.enabled:
        return {'ok': False, 'method': 'none', 'reason': 'the element is disabled', 'disabled': True}
    if 'Action' in n.ifaces:
        names = action_names(n.acc)
        i = pick_action(names, PRESS_ACTIONS, allow_first=True)
        if i >= 0:
            done, pending = run_action(n.acc, i)
            if done:
                out = {'ok': True, 'method': 'action:%s' % (names[i] or i)}
                if pending:
                    out['pending'] = True
                return out
    if select_via_parent(n):
        return {'ok': True, 'method': 'selection'}
    return {'ok': False, 'method': 'none', 'reason': 'the element has no default action (click it instead)'}


def wait_state(acc, state, want, ms=600):
    until = time.monotonic() + ms / 1000.0
    while True:
        has = state in state_names(acc)
        if has == want or time.monotonic() >= until:
            return has == want
        time.sleep(0.05)


def set_value(n, value):
    if value is None:
        raise HelperError('BAD_REQUEST', 'setValue needs a value')
    if not n.enabled:
        return {'ok': False, 'method': 'none', 'reason': 'the element is disabled', 'disabled': True}
    text = value if isinstance(value, str) else (num_text(value) if isinstance(value, (int, float)) else str(value))
    if 'EditableText' in n.ifaces and ('editable' in n.states or n.role == 'textbox'):
        if safe(lambda: Atspi.EditableText.set_text_contents(n.acc, text), False):
            out = {'ok': True, 'method': 'editableText'}
            if not n.hidden_secret and 'Text' in n.ifaces:
                now = read_text(n.acc, MAX_TEXT_READ).replace(OBJ_CHAR, '')
                if now != text:
                    out['ok'] = False
                    out['reason'] = 'the app did not take the new text'
                    out['method'] = 'none'
            return out
    if 'Value' in n.ifaces:
        try:
            f = float(text)
        except ValueError:
            f = None
        if f is not None and safe(lambda: Atspi.Value.set_current_value(n.acc, f), False):
            return {'ok': True, 'method': 'value', 'value': num_text(safe(lambda: Atspi.Value.get_current_value(n.acc), f))}
    if n.role in ('combobox', 'group', 'tablist', 'menu', 'listitem'):
        res = select_item(n, text)
        if res['ok']:
            return res
    return {'ok': False, 'method': 'none', 'reason': 'the element does not take a value through accessibility (focus it and type instead)'}


def select_item(n, value):
    """Pick the descendant option named value (combo boxes, lists, menus, tab lists)."""
    q = norm(value)
    best = None
    best_score = 0
    queue = deque([(n.acc, 0)])
    scanned = 0
    while queue and scanned < 800:
        acc, d = queue.popleft()
        scanned += 1
        if d > 0:
            c = Node(acc)
            s = match_score(c.name, q)
            if s > best_score and c.role in ('listitem', 'menuitem', 'tab', 'treeitem', 'radio', 'cell', 'other', 'text'):
                best, best_score = c, s
                if s == 3:
                    break
        if d < 5:
            for _, ch in children_of(acc, 500):
                queue.append((ch, d + 1))
    if best is None:
        return {'ok': False, 'method': 'none', 'reason': 'no option named "%s"' % clip(value, 80)}
    if select_via_parent(best):
        return {'ok': True, 'method': 'selection', 'item': best.name}
    if 'Action' in best.ifaces:
        names = action_names(best.acc)
        i = pick_action(names, PRESS_ACTIONS, allow_first=True)
        if i >= 0:
            done, pending = run_action(best.acc, i)
            if done:
                out = {'ok': True, 'method': 'item-action:%s' % (names[i] or i), 'item': best.name}
                if pending:
                    out['pending'] = True
                return out
    return {'ok': False, 'method': 'none', 'reason': 'the option "%s" cannot be selected through accessibility' % clip(best.name, 80)}


def expand(n, want):
    st = n.states
    if 'expandable' not in st and 'expanded' not in st and n.role not in ('combobox', 'menuitem', 'treeitem', 'button'):
        return {'ok': False, 'method': 'none', 'reason': 'the element cannot be expanded'}
    if ('expanded' in st) == want and ('expandable' in st or 'expanded' in st):
        return {'ok': True, 'method': 'none', 'reason': 'already %s' % ('expanded' if want else 'collapsed')}
    if 'Action' not in n.ifaces:
        return {'ok': False, 'method': 'none', 'reason': 'the element has no expand action'}
    names = action_names(n.acc)
    order = EXPAND_ACTIONS if want else ('collapse',) + EXPAND_ACTIONS
    i = pick_action(names, order)
    if i < 0:
        return {'ok': False, 'method': 'none', 'reason': 'the element has no expand action'}
    done, pending = run_action(n.acc, i)
    if not done:
        return {'ok': False, 'method': 'none', 'reason': 'the app refused the action'}
    out = {'ok': True, 'method': 'action:%s' % (names[i] or i)}
    if pending:
        out['pending'] = True
    elif 'expandable' in st and not wait_state(n.acc, 'expanded', want):
        out['confirmed'] = False
    return out


def show_menu(n):
    if 'Action' in n.ifaces:
        names = action_names(n.acc)
        i = pick_action(names, MENU_ACTIONS)
        if i >= 0:
            done, pending = run_action(n.acc, i)
            if done:
                out = {'ok': True, 'method': 'action:%s' % names[i]}
                if pending:
                    out['pending'] = True
                return out
    if n.role in ('button', 'menuitem', 'combobox') and ('expandable' in n.states or 'has-popup' in n.states):
        return expand(n, True)
    return {'ok': False, 'method': 'none', 'reason': 'the element has no menu action'}


def perform(n, action, value):
    if action == 'press':
        return press(n)
    if action == 'focus':
        if safe(lambda: Atspi.Component.grab_focus(n.acc), False):
            return {'ok': True, 'method': 'grabFocus'}
        return {'ok': False, 'method': 'none', 'reason': 'the element cannot take keyboard focus'}
    if action == 'setValue':
        return set_value(n, value)
    if action == 'select':
        if value is not None and str(value).strip():
            return select_item(n, str(value))
        if select_via_parent(n):
            return {'ok': True, 'method': 'selection'}
        if 'Action' in n.ifaces:
            names = action_names(n.acc)
            i = pick_action(names, ('select', 'click', 'press', 'activate'))
            if i >= 0:
                done, pending = run_action(n.acc, i)
                if done:
                    out = {'ok': True, 'method': 'action:%s' % names[i]}
                    if pending:
                        out['pending'] = True
                    return out
        return {'ok': False, 'method': 'none', 'reason': 'the element cannot be selected through accessibility'}
    if action in ('expand', 'collapse'):
        return expand(n, action == 'expand')
    if action == 'scrollIntoView':
        st = getattr(Atspi, 'ScrollType', None)
        if st is not None and 'Component' in n.ifaces and safe(lambda: Atspi.Component.scroll_to(n.acc, st.ANYWHERE), False):
            return {'ok': True, 'method': 'scrollTo'}
        if 'focusable' in n.states and safe(lambda: Atspi.Component.grab_focus(n.acc), False):
            return {'ok': True, 'method': 'grabFocus'}
        return {'ok': False, 'method': 'none', 'reason': 'the app cannot scroll this element into view'}
    if action == 'showMenu':
        return show_menu(n)
    raise HelperError('BAD_REQUEST', 'unknown action %r' % action)


def parse_path(p):
    if isinstance(p, list):
        items = p
    else:
        s = str(p or '').strip()
        items = [x for x in s.split('.') if x != ''] if s else []
    out = []
    for x in items:
        try:
            i = int(x)
        except (TypeError, ValueError):
            raise HelperError('BAD_REQUEST', 'bad element path %r' % (p,))
        if i < 0:
            raise HelperError('BAD_REQUEST', 'bad element path %r' % (p,))
        out.append(i)
    return tuple(out)


def cmd_action(req, desktop):
    action = str(req.get('action') or 'press')
    if action not in ACTIONS:
        raise HelperError('BAD_REQUEST', 'unknown action %r' % action)
    coords = Coords(req.get('origin'))
    ref = req.get('window') or {}
    win, popups = pick_window(desktop, ref, coords)
    apply_scale(coords, win, ref)
    OPTIONS['group_text'] = not chromium_like(win)
    root_tag = str(req.get('root') or 'w')
    root = None
    if root_tag == 'w':
        root = win['acc']
    elif root_tag.startswith('p') and root_tag[1:].isdigit():
        k = int(root_tag[1:])
        for p in popups:
            if p['index'] == k:
                root = p['acc']
        if root is None:
            raise HelperError('STALE', 'The menu or pop-up this element was in is closed.')
    else:
        raise HelperError('BAD_REQUEST', 'bad element root %r' % root_tag)
    path = parse_path(req.get('path'))
    want = str(req.get('hash') or '')
    deadline = time.monotonic() + clamp_int(req.get('budgetMs'), 200, MAX_BUDGET_MS, 4000) / 1000.0
    n, found_path, how = resolve(root, path, want, deadline)
    if n is None:
        raise HelperError('STALE', 'The element is no longer in the window (it changed or closed).')
    res = perform(n, action, req.get('value'))
    res['role'] = n.role
    res['name'] = n.name
    res['ref'] = make_ref(root_tag, found_path, n.role, n.name)
    if how == 'moved':
        res['resolved'] = 'moved'
    b = coords.extents(n.acc) if 'Component' in n.ifaces else None
    if b:
        res['bounds'] = b
    return res


def cmd_probe():
    desktop = init_atspi()
    apps = []
    for _, app in children_of(desktop, 400):
        apps.append({'name': safe(app.get_name, '') or '', 'pid': safe(app.get_process_id, 0) or 0,
                     'toolkit': safe(app.get_toolkit_name, '') or ''})
    return {'ok': True, 'protocol': PROTOCOL, 'python': sys.version.split()[0], 'executable': sys.executable,
            'atspi': '%d.%d' % (Atspi.get_version()[0], Atspi.get_version()[1]) if hasattr(Atspi, 'get_version') else '',
            'apps': apps[:100], 'appCount': len(apps)}


def dispatch(req):
    cmd = req.get('cmd')
    if cmd == 'version':
        return {'ok': True, 'protocol': PROTOCOL, 'python': sys.version.split()[0]}
    if cmd == 'roles':
        out = []
        for it in req.get('items') or []:
            it = it if isinstance(it, dict) else {'role': it}
            states = set(it.get('states') or [])
            out.append(shared_role(it.get('role'), states, bool(it.get('editable'))))
        return {'ok': True, 'roles': out}
    if cmd == 'match':
        q = req.get('query')
        return {'ok': True, 'scores': [match_score(s, q, bool(req.get('exact'))) for s in req.get('items') or []]}
    if cmd == 'probe':
        return cmd_probe()
    if cmd in ('tree', 'find', 'action'):
        desktop = init_atspi()
        if cmd == 'tree':
            return cmd_tree(req, desktop)
        if cmd == 'find':
            return cmd_find(req, desktop)
        return cmd_action(req, desktop)
    raise HelperError('BAD_REQUEST', 'unknown command %r' % (cmd,))


def main():
    try:
        raw = sys.stdin.buffer.read().decode('utf-8', 'replace')
        try:
            req = json.loads(raw) if raw.strip() else {}
        except ValueError as e:
            raise HelperError('BAD_REQUEST', 'bad JSON request: %s' % e)
        if not isinstance(req, dict):
            raise HelperError('BAD_REQUEST', 'the request must be a JSON object')
        out = dispatch(req)
    except HelperError as e:
        out = {'ok': False, 'code': e.code, 'error': str(e)}
        out.update(e.extra)
    except Exception as e:  # never die without an answer
        out = {'ok': False, 'code': 'ERROR', 'error': '%s: %s' % (type(e).__name__, e)}
    sys.stdout.write(json.dumps(out, ensure_ascii=True, separators=(',', ':')))
    sys.stdout.write('\n')
    sys.stdout.flush()


if __name__ == '__main__':
    main()
