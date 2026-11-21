#import <UIKit/UIKit.h>
#import <dispatch/dispatch.h>
#include <stdio.h>

extern int bunny_single_emission_main(int argc, char **argv);

static void runExperiment(NSArray<NSString *> *arguments)
{
  NSUInteger marker = [arguments indexOfObject:@"--single-emission"];
  if (marker == NSNotFound || arguments.count - marker != 4)
    return;

  NSString *nonce = arguments[marker + 3];
  NSUUID *runID = [[NSUUID alloc] initWithUUIDString:nonce];
  if (!runID || ![runID.UUIDString.lowercaseString isEqualToString:nonce])
    return;

  NSString *directory = NSTemporaryDirectory();
  NSString *base = [directory stringByAppendingPathComponent:nonce];
  NSString *ca = [base stringByAppendingString:@".pem"];
  NSString *incomplete = [base stringByAppendingString:@".pending"];
  NSString *result = [base stringByAppendingString:@".json"];
  if (!freopen(incomplete.fileSystemRepresentation, "w", stdout))
    return;

  char *argv[] = {
    "single-emission",
    (char *)arguments[marker + 1].UTF8String,
    (char *)arguments[marker + 2].UTF8String,
    (char *)ca.fileSystemRepresentation,
    NULL
  };
  int status = bunny_single_emission_main(4, argv);
  if (status == 0 && !ferror(stdout) && fflush(stdout) == 0 && fclose(stdout) == 0)
    rename(incomplete.fileSystemRepresentation, result.fileSystemRepresentation);
}

@interface ExperimentSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation ExperimentSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session
      options:(UISceneConnectionOptions *)connectionOptions
{
  (void)session;
  (void)connectionOptions;
  if (![scene isKindOfClass:UIWindowScene.class])
    return;
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [UIViewController new];
  [self.window makeKeyAndVisible];

  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      runExperiment(arguments);
    });
  });
}
@end

@interface ExperimentAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation ExperimentAppDelegate
@end

int main(int argc, char *argv[])
{
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(ExperimentAppDelegate.class));
  }
}
