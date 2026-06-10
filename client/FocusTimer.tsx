import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing, Pressable } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { useTheme } from './theme';

interface FocusTimerProps {
  secondsLeft: number;
  minutesTarget: number;
  sessionId: string;
  onGiveUp: () => void;
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const ENCOURAGING_MESSAGES = [
  "You're doing great! 🌟",
  "Stay focused! 🎯",
  "Keep it up! 💪",
  "Almost there! 🚀",
  "Crushing it! 🔥"
];

export default function FocusTimer({ secondsLeft, minutesTarget, sessionId, onGiveUp }: FocusTimerProps) {
  const { colors } = useTheme();
  const size = 280;
  const strokeWidth = 16;
  const center = size / 2;
  const radius = center - strokeWidth - 10; // Padding for glow
  const circumference = 2 * Math.PI * radius;
  
  const targetSeconds = minutesTarget * 60;
  const progress = Math.max(0, Math.min(1, secondsLeft / targetSeconds));
  
  // Animate the stroke dashoffset smoothly
  const animatedProgress = useRef(new Animated.Value(progress)).current;
  
  // Pulse animation for the glow effect
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Random encouraging message
  const [message, setMessage] = useState(ENCOURAGING_MESSAGES[0]);

  useEffect(() => {
    // Change message every 60 seconds
    const interval = setInterval(() => {
      setMessage(ENCOURAGING_MESSAGES[Math.floor(Math.random() * ENCOURAGING_MESSAGES.length)]);
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    Animated.timing(animatedProgress, {
      toValue: progress,
      duration: 1000,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
  }, [progress]);

  useEffect(() => {
    // Continuous subtle pulsing effect
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, []);

  const strokeDashoffset = animatedProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [circumference, 0],
  });

  const formatDuration = (secondsLeft: number): string => {
    const minutes = Math.floor(secondsLeft / 60)
      .toString()
      .padStart(2, "0");
    const seconds = Math.floor(secondsLeft % 60)
      .toString()
      .padStart(2, "0");
    return `${minutes}:${seconds}`;
  };

  const styles = createStyles(colors);

  return (
    <View style={styles.container}>
      <Text style={styles.messageText}>{message}</Text>
      
      <View style={styles.svgContainer}>
        {/* Glow effect */}
        <Animated.View style={[styles.glowWrapper, { transform: [{ scale: pulseAnim }] }]}>
          <Svg width={size} height={size}>
            <Defs>
              <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
                <Stop offset="70%" stopColor={colors.timerGlow} stopOpacity="0.3" />
                <Stop offset="100%" stopColor={colors.timerGlow} stopOpacity="0" />
              </RadialGradient>
            </Defs>
            <Circle cx={center} cy={center} r={radius + strokeWidth} fill="url(#glow)" />
          </Svg>
        </Animated.View>

        <Svg width={size} height={size} style={styles.svg}>
          {/* Background Track */}
          <Circle
            cx={center}
            cy={center}
            r={radius}
            stroke={colors.timerTrack}
            strokeWidth={strokeWidth}
            fill="transparent"
          />
          {/* Active Progress */}
          <AnimatedCircle
            cx={center}
            cy={center}
            r={radius}
            stroke={colors.timerProgress}
            strokeWidth={strokeWidth}
            fill="transparent"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            rotation="-90"
            originX={center}
            originY={center}
          />
        </Svg>
        
        {/* Timer Text */}
        <View style={styles.textContainer}>
          <Text style={styles.timerValue}>{formatDuration(secondsLeft)}</Text>
          <Text style={styles.timerLabel}>Target: {minutesTarget} min</Text>
        </View>
      </View>

      <Pressable style={styles.buttonEnd} onPress={onGiveUp}>
        <Text style={styles.buttonText}>End Session</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: colors.surface,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 10,
    marginVertical: 10,
    width: '100%',
  },
  messageText: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 24,
    textAlign: 'center',
  },
  svgContainer: {
    width: 280,
    height: 280,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  glowWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  svg: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  textContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  timerValue: {
    color: colors.textPrimary,
    fontSize: 64,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 2,
    textShadowColor: colors.timerGlow,
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  timerLabel: {
    color: colors.textSecondary,
    fontSize: 18,
    fontWeight: '600',
    marginTop: 4,
  },
  buttonEnd: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 2,
    borderColor: colors.border,
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 999,
  },
  buttonText: {
    color: colors.textSecondary,
    fontWeight: '700',
    fontSize: 16,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
});
