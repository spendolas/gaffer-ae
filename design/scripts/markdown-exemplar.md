# Comp audit complete

## What I found

### Layer notes

#### Timing details

##### Fine print

###### Micro caption

I scanned **Main_Comp** and found *3 expression errors*, ***one critical***, plus ~~2 false alarms~~ that resolved on refresh. The `wiggle(2, 50)` on **Logo › Position** references a [missing slider](https://github.com/spendolas/gaffer-ae) — autolink check: https://helpx.adobe.com/after-effects.html

- Shape layers use `ADBE Vector Group` contents
  - Path sits before Stroke before Fill
  - New paths need `moveTo(1)`
- Time is seconds, not frames

1. Read the expression
2. Patch in place
3. Verify `expressionError` is clean

- [x] Relinked footage
- [ ] Re-render preview

> Undo groups wrap every mutation — the panel's safety wrap is the only group.
> > Nested note: AE shows an "undo mismatch" dialog otherwise.

```javascript
var comp = app.project.activeItem;
var layer = comp.layer(1); // 1-indexed!
layer.property("ADBE Transform Group")
     .property("ADBE Position")
     .expression = "wiggle(2, 50)";
```

| Property | Value | Status |
|:---------|------:|:------:|
| fps | 30 | ok |
| duration | 10s | ok |
| expressions | 14 | 1 error |

---

![swatch](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNgYPj/n4GBgYGJgQIAAD0kAQGkDpFPAAAAAElFTkSuQmCC)

Final paragraph after the rule — plain body text to close.
