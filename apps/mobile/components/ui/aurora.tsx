// Port of the web's dark AuroraBackground (apps/web/src/components/aurora-background.tsx): the
// slate-950 → slate-900 → black base, the static radial blobs, and two drifting layers (web: 6 s
// `aurora` keyframes, the second reversed at 7.5 s). Same hues, positions and alphas; radii are
// scaled from the web's desktop pixels to the phone's viewport. Decorative, behind every screen.
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, { Defs, Ellipse, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";

type Blob = { cx: number; cy: number; rx: number; ry: number; rgb: string; a: number };

// Positions are fractions of the layer; rx/ry are fractions of the viewport width (web px / ~1000).
const BASE: Blob[] = [
  { cx: 0.2, cy: 0, rx: 1.3, ry: 0.95, rgb: "59,130,246", a: 0.08 },
  { cx: 0.8, cy: 1, rx: 0.95, ry: 1.3, rgb: "147,51,234", a: 0.05 },
  { cx: 1, cy: 0, rx: 1.1, ry: 0.8, rgb: "99,102,241", a: 0.07 },
  { cx: 0, cy: 1, rx: 1.3, ry: 1.1, rgb: "139,92,246", a: 0.05 },
];
const DRIFT_A: Blob[] = [
  { cx: 0.2, cy: 0.8, rx: 1.3, ry: 1.3, rgb: "99,102,241", a: 0.07 },
  { cx: 0.8, cy: 0.2, rx: 1.3, ry: 1.3, rgb: "139,92,246", a: 0.05 },
  { cx: 0.6, cy: 0.6, rx: 0.95, ry: 0.95, rgb: "59,130,246", a: 0.08 },
];
const DRIFT_B: Blob[] = [
  { cx: 0.8, cy: 0.8, rx: 0.95, ry: 0.95, rgb: "147,51,234", a: 0.04 },
  { cx: 0.2, cy: 0.2, rx: 1.1, ry: 1.1, rgb: "99,102,241", a: 0.06 },
];

function Blobs({ id, blobs, width, height, w }: { id: string; blobs: Blob[]; width: number; height: number; w: number }) {
  return (
    <Svg width={width} height={height}>
      <Defs>
        {blobs.map((b, i) => (
          <RadialGradient key={i} id={`${id}${i}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={`rgb(${b.rgb})`} stopOpacity={b.a} />
            <Stop offset="1" stopColor={`rgb(${b.rgb})`} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      {blobs.map((b, i) => (
        <Ellipse key={i} cx={b.cx * width} cy={b.cy * height} rx={b.rx * w} ry={b.ry * w} fill={`url(#${id}${i})`} />
      ))}
    </Svg>
  );
}

/** One drifting layer: twice the viewport wide, sliding back and forth like background-position 0% → 100%. */
function Drift({ id, blobs, width, height, duration, reverse }: { id: string; blobs: Blob[]; width: number; height: number; duration: number; reverse?: boolean }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (reduced) return;
      const ease = Easing.inOut(Easing.ease);
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(t, { toValue: 1, duration: duration / 2, easing: ease, useNativeDriver: true }),
          Animated.timing(t, { toValue: 0, duration: duration / 2, easing: ease, useNativeDriver: true }),
        ]),
      );
      loop.start();
    });
    return () => loop?.stop();
  }, [t, duration]);
  const translateX = t.interpolate({ inputRange: [0, 1], outputRange: reverse ? [-width, 0] : [0, -width] });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { width: width * 2, transform: [{ translateX }] }]}>
      <Blobs id={id} blobs={blobs} width={width * 2} height={height} w={width} />
    </Animated.View>
  );
}

export function AuroraBackground() {
  const { width, height } = useWindowDimensions();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip]}>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          {/* bg-gradient-to-br from-slate-950 via-slate-900 to-black */}
          <LinearGradient id="base" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#020617" />
            <Stop offset="0.5" stopColor="#0f172a" />
            <Stop offset="1" stopColor="#000000" />
          </LinearGradient>
        </Defs>
        <Rect width={width} height={height} fill="url(#base)" />
      </Svg>
      <View style={StyleSheet.absoluteFill}>
        <Blobs id="s" blobs={BASE} width={width} height={height} w={width} />
      </View>
      <Drift id="a" blobs={DRIFT_A} width={width} height={height} duration={6000} />
      <Drift id="b" blobs={DRIFT_B} width={width} height={height} duration={7500} reverse />
    </View>
  );
}

const styles = StyleSheet.create({ clip: { overflow: "hidden" } });
